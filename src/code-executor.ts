import vm from "node:vm";
import { z } from "zod";
import type { DirectResponse, DirectServiceDependencies } from "./direct-service.ts";
import { DirectSessionExecutor } from "./session-executor.ts";
import {
	COMPUTER_USE_METHODS,
	type DirectMethod,
	type DirectToolArguments,
	type JsonObject,
	type JsonValue,
} from "./tools.ts";

const MAX_CODE_BYTES = 20_000;
const MAX_CALLS = 50;
const SYNC_TIMEOUT_MS = 5_000;

export interface ComputerUseCodeResult {
	content: JsonObject[];
	calls: DirectMethod[];
}

interface ImageValue extends JsonObject {
	type: "image";
	data: string;
	mimeType: string;
}

const emittedValueSchema = z.json();
const emittedStringSchema = z.string();
const imageValueSchema = z.object({
	type: z.literal("image"),
	data: z.string(),
	mimeType: z.string(),
});

function textFrom(response: DirectResponse): string {
	return response.content
		.filter((block) => block.type !== "image")
		.map((block) => String(block.text ?? ""))
		.join("\n");
}

function imagesFrom(response: DirectResponse): ImageValue[] {
	return response.content
		.filter((block) => block.type === "image")
		.map((block) => ({
			type: "image" as const,
			data: String(block.data),
			mimeType: String(block.mimeType),
		}));
}

function listAppsFrom(text: string): JsonValue {
	const apps: JsonObject[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^(.*?) — .*? — (\S+?)(?: \[(.*)\])?$/);
		if (!match) continue;
		const details = match[3]?.split(", ") ?? [];
		const app: JsonObject = { id: match[2], displayName: match[1] };
		if (details.includes("running") || details.includes("frontmost")) app.isRunning = true;
		const lastUsed = details.find((detail) => detail.startsWith("last-used="));
		if (lastUsed) app.lastUsedDate = lastUsed.slice("last-used=".length);
		const uses = details.find((detail) => detail.startsWith("uses="));
		if (uses) app.useCount = Number(uses.slice("uses=".length));
		apps.push(app);
	}
	return apps.length > 0 ? apps : text;
}

function valueFrom(method: DirectMethod, args: DirectToolArguments, response: DirectResponse): JsonValue | undefined {
	const text = textFrom(response);
	if (method === "list_apps") return listAppsFrom(text);
	if (method === "get_app_state") {
		return {
			app: String(args.app),
			text,
			screenshot: imagesFrom(response)[0] ?? null,
		};
	}
	if (response.structuredContent !== undefined) return response.structuredContent;
	return text || undefined;
}

function errorFrom(response: DirectResponse): Error {
	return new Error(textFrom(response).slice(0, 2_000) || "Official Computer Use returned an error");
}

export class ComputerUseCodeExecutor {
	private queue = Promise.resolve();
	private readonly sessionExecutor: DirectSessionExecutor;
	readonly store: Record<string, JsonValue | undefined> = {};

	constructor(sessionExecutor = new DirectSessionExecutor()) {
		this.sessionExecutor = sessionExecutor;
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	execute(code: string, dependencies: DirectServiceDependencies): Promise<ComputerUseCodeResult> {
		return this.runExclusive(async () => {
			if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
				throw new Error(`Computer Use code exceeds ${MAX_CODE_BYTES} bytes`);
			}

			const content: JsonObject[] = [];
			const calls: DirectMethod[] = [];
			const methodSchema = z.enum(COMPUTER_USE_METHODS);
			const argumentsSchema = z.record(z.string(), z.json());
			const callBridge = async (rawMethod: string, rawArguments: string): Promise<string> => {
				if (calls.length >= MAX_CALLS) throw new Error(`Computer Use code exceeded ${MAX_CALLS} calls`);
				const method = methodSchema.parse(rawMethod);
				const args = argumentsSchema.parse(JSON.parse(rawArguments));
				calls.push(method);
				const response = await this.sessionExecutor.execute(method, args, dependencies);
				if (response.isError) throw errorFrom(response);
				return JSON.stringify(valueFrom(method, args, response) ?? null);
			};
			const emitBridge = (rawValue: string): void => {
				const parsed = emittedValueSchema.parse(JSON.parse(rawValue));
				const stringResult = emittedStringSchema.safeParse(parsed);
				content.push({
					type: "text",
					text: stringResult.success ? stringResult.data : JSON.stringify(parsed, null, 2),
				});
			};
			const emitImageBridge = (rawValue: string): void => {
				const parsed = imageValueSchema.parse(JSON.parse(rawValue));
				content.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
			};
			Object.setPrototypeOf(callBridge, null);
			Object.setPrototypeOf(emitBridge, null);
			Object.setPrototypeOf(emitImageBridge, null);
			const context = vm.createContext({
				__callBridge: callBridge,
				__emitBridge: emitBridge,
				__emitImageBridge: emitImageBridge,
				__storeJson: JSON.stringify(this.store),
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
	globalThis.emitImage = (value) => emitImageBridge(JSON.stringify(value));
	globalThis.store = JSON.parse(storeJson);
})()`);
			bootstrap.runInContext(context, { timeout: SYNC_TIMEOUT_MS });
			const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "computer-use.js" });
			await script.runInContext(context, { timeout: SYNC_TIMEOUT_MS });
			const rawStore = new vm.Script("JSON.stringify(store)").runInContext(context, { timeout: SYNC_TIMEOUT_MS });
			const nextStore = argumentsSchema.parse(JSON.parse(String(rawStore)));
			for (const key of Object.keys(this.store)) delete this.store[key];
			Object.assign(this.store, nextStore);
			return { content, calls };
		});
	}

	async close(): Promise<void> {
		await this.runExclusive(() => this.sessionExecutor.close());
	}
}
