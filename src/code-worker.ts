import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import type { JsonObject } from "./tools.ts";

interface WorkerInput {
	code: string;
	store: JsonObject;
}

interface CallResultMessage {
	type: "call_result";
	id: number;
	value?: string;
	error?: string;
}

// SAFETY: ComputerUseCodeExecutor is the sole worker creator and supplies this exact cloneable shape.
const input = workerData as WorkerInput;
const port = parentPort;
if (!port) throw new Error("Computer Use code worker requires a parent port");

let nextCallId = 1;
const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();

port.on("message", (message: CallResultMessage) => {
	if (message.type !== "call_result") return;
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.error) waiter.reject(new Error(message.error));
	else waiter.resolve(message.value ?? "null");
});

const callBridge = (method: string, args: string): Promise<string> => {
	const id = nextCallId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		port.postMessage({ type: "call", id, method, args });
	});
};
const emitBridge = (value: string): void => port.postMessage({ type: "emit", value });
const emitImageBridge = (value: string): void => port.postMessage({ type: "emit_image", value });
Object.setPrototypeOf(callBridge, null);
Object.setPrototypeOf(emitBridge, null);
Object.setPrototypeOf(emitImageBridge, null);

const context = vm.createContext({
	__callBridge: callBridge,
	__emitBridge: emitBridge,
	__emitImageBridge: emitImageBridge,
	__storeJson: JSON.stringify(input.store),
}, {
	codeGeneration: { strings: false, wasm: false },
	name: "computer-use",
});

const bootstrap = new vm.Script(`(() => {
	const callBridge = globalThis.__callBridge;
	const emitBridge = globalThis.__emitBridge;
	const emitImageBridge = globalThis.__emitImageBridge;
	const storeJson = globalThis.__storeJson;
	delete globalThis.__callBridge;
	delete globalThis.__emitBridge;
	delete globalThis.__emitImageBridge;
	delete globalThis.__storeJson;
	const call = async (method, args = {}) => JSON.parse(await callBridge(method, JSON.stringify(args)));
	globalThis.sky = Object.freeze({
		list_apps: (args) => call("list_apps", args),
		get_app_state: (args) => call("get_app_state", args),
		click: (args) => call("click", args),
		perform_secondary_action: (args) => call("perform_secondary_action", args),
		set_value: (args) => call("set_value", args),
		select_text: (args) => call("select_text", args),
		scroll: (args) => call("scroll", args),
		drag: (args) => call("drag", args),
		press_key: (args) => call("press_key", args),
		type_text: (args) => call("type_text", args),
	});
	globalThis.emit = (value) => emitBridge(JSON.stringify(value));
	globalThis.emitImage = (value) => {
		if (value === null) throw new Error("get_app_state returned no screenshot");
		emitImageBridge(JSON.stringify(value));
	};
	globalThis.store = JSON.parse(storeJson);
})()`);

try {
	bootstrap.runInContext(context);
	const script = new vm.Script(`(async () => {\n${input.code}\n})()`, { filename: "computer-use.js" });
	await script.runInContext(context);
	const rawStore = new vm.Script("JSON.stringify(store)").runInContext(context);
	port.postMessage({ type: "done", store: String(rawStore) });
} catch (error) {
	port.postMessage({
		type: "done",
		store: JSON.stringify(input.store),
		error: error instanceof Error ? error.message : String(error),
	});
}
