import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import adapter, { handleOfficialElicitation, toPiContent } from "../integrations/pi/index.ts";
import { ComputerUseCodeExecutor } from "../src/code-executor.ts";
import type { DirectBrokerResult } from "../src/direct-broker.ts";
import { DirectSessionExecutor } from "../src/session-executor.ts";
import { type DirectMethod, type DirectToolArguments } from "../src/tools.ts";

function brokerResult(text: string): DirectBrokerResult {
	return {
		content: [{ type: "text", text }],
		isError: false,
		brokerVersion: "test",
		clientBuild: "test",
		elicitationRequests: 0,
		modelTurnsStarted: 0,
		ephemeralThread: true,
		brokerCleanupVerified: false,
	};
}

test("Pi returns form elicitation responses", async () => {
	let selectedTitle = "";
	let editorTitle = "";
	let editorPrefill = "";
	const response = await handleOfficialElicitation({
		mode: "form",
		message: "Choose access",
		requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["allow", "deny"] } } },
	}, {
		hasUI: true,
		ui: {
			async select(title) { selectedTitle = title; return "Respond"; },
			async editor(title, prefill) { editorTitle = title; editorPrefill = prefill ?? ""; return '{"choice":"allow"}'; },
			notify() {},
		},
	}, async () => false);
	assert.equal(selectedTitle, "Choose access");
	assert.match(editorTitle, /Schema:/);
	assert.equal(editorPrefill, "{}");
	assert.deepEqual(response, { action: "accept", content: { choice: "allow" } });
});

test("Pi preserves opaque OpenAI form responses", async () => {
	let editorTitle = "";
	const response = await handleOfficialElicitation({
		mode: "openai/form",
		message: "Official custom form",
		requestedSchema: ["opaque", { widget: "custom" }],
	}, {
		hasUI: true,
		ui: {
			async select() { return "Respond"; },
			async editor(title) { editorTitle = title; return '"completed"'; },
			notify() {},
		},
	}, async () => false);
	assert.match(editorTitle, /\["opaque",\{"widget":"custom"\}\]/);
	assert.deepEqual(response, { action: "accept", content: "completed" });
});

test("Pi opens URL elicitations only after acceptance", async () => {
	const opened: string[] = [];
	const accepted = await handleOfficialElicitation({
		mode: "url",
		message: "Complete setup",
		url: "https://example.test/setup",
		elicitationId: "setup-1",
	}, {
		hasUI: true,
		ui: { async select() { return "Open URL"; }, async editor() { return undefined; }, notify() {} },
	}, async (url) => { opened.push(url); return true; });
	assert.deepEqual(opened, ["https://example.test/setup"]);
	assert.deepEqual(accepted, { action: "accept" });

	const declined = await handleOfficialElicitation({
		mode: "url",
		message: "Complete setup",
		url: "https://example.test/setup",
		elicitationId: "setup-2",
	}, {
		hasUI: true,
		ui: { async select() { return "Decline"; }, async editor() { return undefined; }, notify() {} },
	}, async () => { throw new Error("declined URL must not open"); });
	assert.deepEqual(declined, { action: "decline" });
});

test("Pi distinguishes decline from headless cancellation", async () => {
	const request = { mode: "form", message: "Choose", requestedSchema: { type: "object", properties: {} } };
	const declined = await handleOfficialElicitation(request, {
		hasUI: true,
		ui: { async select() { return "Decline"; }, async editor() { return undefined; }, notify() {} },
	}, async () => true);
	assert.deepEqual(declined, { action: "decline" });
	const headless = await handleOfficialElicitation(request, {
		hasUI: false,
		ui: { async select() { throw new Error("unreachable"); }, async editor() { throw new Error("unreachable"); }, notify() {} },
	}, async () => true);
	assert.deepEqual(headless, { action: "cancel" });
});

test("Pi registers and activates one composable Computer Use tool", async () => {
	const tools: Array<{ name: string; description: string; parameters: any }> = [];
	const commands: string[] = [];
	const handlers = new Map<string, () => void>();
	const active = new Set(["read"]);
	const fakePi = {
		registerTool(tool: { name: string; description: string; parameters: any }) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
		on(name: string, handler: () => void) { handlers.set(name, handler); },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active.clear(); for (const name of names) active.add(name); },
	};
	// SAFETY: this focused adapter test implements every ExtensionAPI member used during registration and session_start.
	adapter(fakePi as any);
	assert.deepEqual(commands, ["computer-use-status"]);
	assert.deepEqual(tools.map((tool) => tool.name), ["computer_use"]);
	assert.match(tools[0].description, /sky\.get_app_state/);
	assert.match(tools[0].description, /sky\.type_text/);
	assert.deepEqual(tools[0].parameters.required, ["code"]);
	assert.equal(handlers.has("agent_settled"), true);
	assert.equal(handlers.has("session_shutdown"), true);
	handlers.get("session_start")?.();
	assert.deepEqual([...active].sort(), ["computer_use", "read"]);
});

test("Computer Use code composes calls and emits only requested state", async () => {
	const calls: Array<{ method: DirectMethod; args: DirectToolArguments }> = [];
	const session = {
		async execute(method: DirectMethod, args: DirectToolArguments) {
			calls.push({ method, args });
			if (method === "get_app_state") {
				return {
					isError: false,
					content: [
						{ type: "text", text: "AX tree" },
						{ type: "image", data: "png-data", mimeType: "image/png" },
					],
				};
			}
			return { isError: false, content: [] };
		},
		async close() {},
	};
	// SAFETY: this fake implements the execute and close methods used by ComputerUseCodeExecutor.
	const executor = new ComputerUseCodeExecutor(session as any);
	const result = await executor.execute(`
const state = await sky.get_app_state({ app: "TextEdit" });
await sky.click({ app: "TextEdit", element_index: "7" });
await sky.type_text({ app: "TextEdit", text: "hello" });
emit(state.text);
emitImage(state.screenshot);
`, {});
	assert.deepEqual(calls.map((call) => call.method), ["get_app_state", "click", "type_text"]);
	assert.deepEqual(result.calls, ["get_app_state", "click", "type_text"]);
	assert.deepEqual(result.content, [
		{ type: "text", text: "AX tree" },
		{ type: "image", data: "png-data", mimeType: "image/png" },
	]);
});

test("Computer Use code presents list_apps as the native structured app surface", async () => {
	const session = {
		async execute() {
			return {
				isError: false,
				content: [{ type: "text", text: "TextEdit — /System/Applications/TextEdit.app/ — com.apple.TextEdit [running, last-used=2026-08-21, uses=251]" }],
			};
		},
		async close() {},
	};
	// SAFETY: this fake implements the execute and close methods used by ComputerUseCodeExecutor.
	const executor = new ComputerUseCodeExecutor(session as any);
	const result = await executor.execute(`const apps = await sky.list_apps(); emit(apps);`, {});
	assert.deepEqual(result.content, [{
		type: "text",
		text: `[
  {
    "id": "com.apple.TextEdit",
    "displayName": "TextEdit",
    "isRunning": true,
    "lastUsedDate": "2026-08-21",
    "useCount": 251
  }
]`,
	}]);
});

test("Computer Use code cannot escape through bridge or store constructors", async () => {
	const session = { async execute() { return { isError: false, content: [] }; }, async close() {} };
	// SAFETY: this fake implements the execute and close methods used by ComputerUseCodeExecutor.
	const executor = new ComputerUseCodeExecutor(session as any);
	await assert.rejects(
		executor.execute(`emit(sky.click.constructor("return process")());`, {}),
		/Code generation from strings disallowed/,
	);
	await assert.rejects(
		executor.execute(`emit(store.constructor.constructor("return process")());`, {}),
		/Code generation from strings disallowed/,
	);
});

test("Computer Use code exposes a persistent explicit store", async () => {
	const session = { async execute() { return { isError: false, content: [] }; }, async close() {} };
	// SAFETY: this fake implements the execute and close methods used by ComputerUseCodeExecutor.
	const executor = new ComputerUseCodeExecutor(session as any);
	await executor.execute(`store.count = 1;`, {});
	const result = await executor.execute(`store.count += 1; emit(store);`, {});
	assert.deepEqual(result.content, [{ type: "text", text: `{\n  "count": 2\n}` }]);
});

test("broker setup failures remain audited", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-setup-audit-test."));
	try {
		const executor = new DirectSessionExecutor({
			createSession: async () => { throw new Error("verified broker setup failed"); },
		});
		await assert.rejects(
			executor.execute("get_app_state", { app: "TextEdit" }, { stateRoot: root }),
			/verified broker setup failed/,
		);
		const audit = JSON.parse(await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8"));
		assert.equal(audit.outcome, "broker_failed");
		assert.equal(audit.directCalls, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retained sessions advertise only the caller's elicitation capability", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-session-capability-test."));
	const advertised: boolean[] = [];
	const createExecutor = () => new DirectSessionExecutor({
		createSession: async (options) => {
			advertised.push(options.supportsOpenAiFormElicitation === true);
			return {
				async call() { return brokerResult("state"); },
				async close() {},
			};
		},
	});
	const genericExecutor = createExecutor();
	const piExecutor = createExecutor();
	try {
		await genericExecutor.execute("get_app_state", { app: "TextEdit" }, { stateRoot: root });
		await piExecutor.execute("get_app_state", { app: "TextEdit" }, {
			stateRoot: root,
			supportsOpenAiFormElicitation: true,
		});
		assert.deepEqual(advertised, [false, true]);
	} finally {
		await Promise.all([genericExecutor.close(), piExecutor.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("one signed client session supports a multi-action sequence", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-session-test."));
	const calls: Array<{ session: number; method: DirectMethod }> = [];
	let sessionsCreated = 0;
	let sessionsClosed = 0;
	const executor = new DirectSessionExecutor({
		createSession: async () => {
			const session = ++sessionsCreated;
			return {
				async call(method: DirectMethod) { calls.push({ session, method }); return brokerResult(method); },
				async close() { sessionsClosed += 1; },
			};
		},
	});
	try {
		await executor.execute("get_app_state", { app: "Chrome" }, { stateRoot: root });
		await executor.execute("click", { app: "Chrome", x: 10, y: 10 }, { stateRoot: root });
		await executor.execute("type_text", { app: "Chrome", text: "hello" }, { stateRoot: root });
		await executor.execute("press_key", { app: "Chrome", key: "Escape" }, { stateRoot: root });
		assert.deepEqual(calls.map((call) => call.method), ["get_app_state", "click", "type_text", "press_key"]);
		assert.equal(sessionsCreated, 1);
		assert.equal(sessionsClosed, 0);
		await executor.close();
		assert.equal(sessionsClosed, 1);
	} finally {
		await executor.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("idle expiry closes a retained session", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-idle-test."));
	let sessionsClosed = 0;
	const executor = new DirectSessionExecutor({
		idleTimeoutMs: 10,
		createSession: async () => ({
			async call() { return brokerResult("state"); },
			async close() { sessionsClosed += 1; },
		}),
	});
	try {
		await executor.execute("get_app_state", { app: "TextEdit" }, { stateRoot: root });
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(sessionsClosed, 1);
	} finally {
		await executor.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi truncates text to a private spill file without spilling images", async () => {
	const original = "x".repeat(60 * 1024);
	const rendered = await toPiContent([
		{ type: "text", text: original },
		{ type: "image", data: "image-data", mimeType: "image/png" },
	]);
	assert.ok(rendered.fullOutputPath);
	try {
		assert.equal(await readFile(rendered.fullOutputPath, "utf8"), original);
		assert.equal((await stat(rendered.fullOutputPath)).mode & 0o777, 0o600);
		assert.match(rendered.content[0].type === "text" ? rendered.content[0].text : "", /Full output saved to:/);
		assert.deepEqual(rendered.content[1], { type: "image", data: "image-data", mimeType: "image/png" });
	} finally {
		await rm(path.dirname(rendered.fullOutputPath), { recursive: true, force: true });
	}
});
