import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TOOL_INPUT_SCHEMAS, COMPUTER_USE_METHODS, TOOL_METADATA } from "../src/tools.ts";

test("Pi surfaces an official form elicitation and returns the user's structured response", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	const calls: Array<{ kind: string; value: unknown }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			async select(title: string, options: string[]) { calls.push({ kind: "select", value: { title, options } }); return "Respond"; },
			async editor(title: string, prefill?: string) { calls.push({ kind: "editor", value: { title, prefill } }); return '{"choice":"allow"}'; },
			notify(message: string) { calls.push({ kind: "notify", value: message }); },
		},
	};
	const response = await handleOfficialElicitation({
		mode: "form",
		message: "Choose access",
		requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["allow", "deny"] } } },
	}, ctx, async () => { throw new Error("must not open a URL for form elicitation"); });
	assert.deepEqual(response, { action: "accept", content: { choice: "allow" } });
	assert.equal((calls[0].value as any).title, "Choose access");
	assert.match((calls[1].value as any).title, /Schema:/);
	assert.match((calls[1].value as any).prefill, /"choice": "allow"/);
});

test("Pi preserves opaque OpenAI-form schemas and JSON responses", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	let editorTitle = "";
	const response = await handleOfficialElicitation({
		mode: "openai/form", message: "Official custom form", requestedSchema: ["opaque", { widget: "custom" }],
	}, {
		hasUI: true,
		ui: {
			async select() { return "Respond"; },
			async editor(title: string) { editorTitle = title; return '"completed"'; },
			notify() {},
		},
	}, async () => false);
	assert.match(editorTitle, /\["opaque",\{"widget":"custom"\}\]/);
	assert.deepEqual(response, { action: "accept", content: "completed" });
});

test("Pi URL elicitation opens only after user choice and returns that acceptance", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	const choices = ["Open URL"];
	const opened: string[] = [];
	const response = await handleOfficialElicitation({
		mode: "url", message: "Complete setup", url: "https://example.test/setup", elicitationId: "setup-1",
	}, {
		hasUI: true,
		ui: {
			async select() { return choices.shift(); },
			async editor() { return undefined; },
			notify() {},
		},
	}, async (url) => { opened.push(url); return true; });
	assert.deepEqual(opened, ["https://example.test/setup"]);
	assert.deepEqual(response, { action: "accept" });

	const declined = await handleOfficialElicitation({
		mode: "url", message: "Complete setup", url: "https://example.test/setup", elicitationId: "setup-2",
	}, {
		hasUI: true,
		ui: { async select() { return "Decline"; }, async editor() { return undefined; }, notify() {} },
	}, async () => { throw new Error("declined URL must not open"); });
	assert.deepEqual(declined, { action: "decline" });
});

test("Pi preserves explicit decline and uses cancel when no UI is available", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
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

test("Pi runtime registers all ten Computer Use tools", async () => {
	const {
		default: adapter,
		INSPECTION_TOOL_NAMES,
		INTERACTION_TOOL_NAMES,
	} = await import("../integrations/pi/index.ts");
	const tools: Array<{
		name: string;
		description: string;
		parameters: unknown;
		promptSnippet?: string;
		promptGuidelines?: string[];
	}> = [];
	const commands: string[] = [];
	const handlers = new Map<string, () => void>();
	const active = new Set(["read", ...COMPUTER_USE_METHODS.map((method) => `computer_use_${method}`)]);
	adapter({
		registerTool(tool: typeof tools[number]) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
		on(name: string, handler: () => void) { handlers.set(name, handler); },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active.clear(); for (const name of names) active.add(name); },
	} as any);
	assert.deepEqual(commands, ["computer-use-status"]);
	assert.deepEqual(tools.map((tool) => tool.name).sort(), COMPUTER_USE_METHODS.map((method) => `computer_use_${method}`).sort());
	for (const method of COMPUTER_USE_METHODS) {
		const tool = tools.find((item) => item.name === `computer_use_${method}`)!;
		assert.match(tool.description, new RegExp(`^${TOOL_METADATA[method].description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(tool.description, /full text is saved to a temporary file/);
		assert.deepEqual(tool.parameters, TOOL_INPUT_SCHEMAS[method]);
		if (INSPECTION_TOOL_NAMES.includes(tool.name as any)) {
			assert.ok(tool.promptSnippet);
			assert.ok(tool.promptGuidelines?.length);
		} else {
			assert.equal(tool.promptSnippet, undefined);
			assert.equal(tool.promptGuidelines, undefined);
		}
	}

	handlers.get("session_start")!();
	assert.ok(active.has("read"), "preserves tools owned by Pi and other extensions");
	for (const name of [...INSPECTION_TOOL_NAMES, ...INTERACTION_TOOL_NAMES]) {
		assert.ok(active.has(name), `activates direct tool ${name}`);
	}
});

test("Pi broker setup failures stay inside the audited direct-service path", async () => {
	const { PiDirectSessionExecutor } = await import("../integrations/pi/index.ts");
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-setup-audit-test."));
	try {
		const executor = new PiDirectSessionExecutor({
			createSession: async () => { throw new Error("verified broker setup failed"); },
		} as any);
		await assert.rejects(executor.execute("get_app_state", { app: "TextEdit" }, {
			stateRoot: root,
		} as any), /verified broker setup failed/);
		const audit = JSON.parse((await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "broker_failed");
		assert.equal(audit.brokerCleanupVerified, false);
		assert.equal(audit.directCalls, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi direct executor retains one signed client session across a multi-action sequence", async () => {
	const { PiDirectSessionExecutor } = await import("../integrations/pi/index.ts");
	const calls: Array<{ session: number; method: string }> = [];
	let sessionsCreated = 0;
	let sessionsClosed = 0;
	const executor = new PiDirectSessionExecutor({
		createSession: async () => {
			const session = ++sessionsCreated;
			return {
				async call(method: string) {
					calls.push({ session, method });
					return {
						content: [{ type: "text", text: method }], isError: false,
						brokerVersion: "test", clientBuild: "test", durationMs: 1,
						elicitationRequests: 0, modelTurnsStarted: 0, ephemeralThread: true,
						brokerCleanupVerified: false,
					};
				},
				async close() { sessionsClosed += 1; },
			};
		},
		executeTool: async (request: any, dependencies: any) => {
			const broker = await dependencies.callTool(request.method, request.arguments, {});
			return { ok: true, isError: false, content: broker.content, details: {} };
		},
	} as any);
	await executor.execute("get_app_state", { app: "com.google.Chrome" }, {});
	assert.equal(sessionsClosed, 0, "inspection retains the active-app client lease");
	await executor.execute("click", { app: "com.google.Chrome", x: 10, y: 10 }, {});
	await executor.execute("type_text", { app: "com.google.Chrome", text: "hello" }, {});
	await executor.execute("press_key", { app: "com.google.Chrome", key: "Escape" }, {});
	assert.deepEqual(calls, [
		{ session: 1, method: "get_app_state" },
		{ session: 1, method: "click" },
		{ session: 1, method: "type_text" },
		{ session: 1, method: "press_key" },
	]);
	assert.equal(sessionsCreated, 1);
	assert.equal(sessionsClosed, 0, "actions retain the official app-use session");
	await executor.close();
	assert.equal(sessionsClosed, 1, "settled-agent cleanup closes the retained session");
});

test("idle expiry closes a retained session and later calls use a fresh entry", async () => {
	const { PiDirectSessionExecutor } = await import("../integrations/pi/index.ts");
	let sessionsCreated = 0;
	let sessionsClosed = 0;
	const calls: Array<{ session: number; method: string }> = [];
	const executor = new PiDirectSessionExecutor({
		idleTimeoutMs: 10,
		createSession: async () => {
			const session = ++sessionsCreated;
			return {
				async call(method: string) {
					calls.push({ session, method });
					return {
						content: [{ type: "text", text: "ok" }], isError: false,
						brokerVersion: "test", clientBuild: "test", durationMs: 1,
						elicitationRequests: 0, modelTurnsStarted: 0, ephemeralThread: true,
						brokerCleanupVerified: false,
					};
				},
				async close() { sessionsClosed += 1; },
			};
		},
		executeTool: async (request: any, dependencies: any) => {
			if (!dependencies.callTool) return { ok: true, isError: false, content: [], details: {} };
			const broker = await dependencies.callTool(request.method, request.arguments, {});
			return { ok: true, isError: false, content: broker.content, details: {} };
		},
	} as any);
	try {
		await executor.execute("get_app_state", { app: "TextEdit" }, {});
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(sessionsClosed, 1);
		await executor.execute("get_app_state", { app: "TextEdit" }, {});
		await executor.execute("press_key", { app: "TextEdit", key: "Escape" }, {});
		assert.deepEqual(calls, [
			{ session: 1, method: "get_app_state" },
			{ session: 2, method: "get_app_state" },
			{ session: 2, method: "press_key" },
		]);
	} finally {
		await executor.close();
	}
	assert.equal(sessionsClosed, 2);
});

test("a retained-session cleanup failure blocks later dispatch", async () => {
	const { PiDirectSessionExecutor } = await import("../integrations/pi/index.ts");
	let executeCalls = 0;
	const executor = new PiDirectSessionExecutor({
		createSession: async () => ({
			async call() {
				return {
					content: [{ type: "text", text: "state" }], isError: false,
					brokerVersion: "test", clientBuild: "test", durationMs: 1,
					elicitationRequests: 0, modelTurnsStarted: 0, ephemeralThread: true,
					brokerCleanupVerified: false,
				};
			},
			async close() { throw new Error("verified cleanup failed"); },
		}),
		executeTool: async (request: any, dependencies: any) => {
			executeCalls += 1;
			const broker = await dependencies.callTool(request.method, request.arguments, {});
			return { ok: true, isError: false, content: broker.content, details: {} };
		},
	} as any);
	await executor.execute("get_app_state", { app: "TextEdit" }, {});
	await assert.rejects(executor.close(), /verified cleanup failed/);
	await assert.rejects(executor.execute("list_apps", {}, {}), /verified cleanup failed/);
	assert.equal(executeCalls, 1);
});

test("session composition does not globally serialize different app selectors", async () => {
	const { PiDirectSessionExecutor } = await import("../integrations/pi/index.ts");
	let entered = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const safetyTimer = setTimeout(() => release(), 1_000);
	const executor = new PiDirectSessionExecutor({
		createSession: async () => ({
			async call() {
				entered += 1;
				if (entered === 2) release();
				await held;
				return {
					content: [{ type: "text", text: "state" }], isError: false,
					brokerVersion: "test", clientBuild: "test", durationMs: 1,
					elicitationRequests: 0, modelTurnsStarted: 0, ephemeralThread: true,
					brokerCleanupVerified: false,
				};
			},
			async close() {},
		}),
		executeTool: async (request: any, dependencies: any) => {
			const broker = await dependencies.callTool(request.method, request.arguments, {});
			return { ok: true, isError: false, content: broker.content, details: {} };
		},
	} as any);
	try {
		await Promise.all([
			executor.execute("get_app_state", { app: "App A" }, {}),
			executor.execute("get_app_state", { app: "App B" }, {}),
		]);
		assert.equal(entered, 2);
	} finally {
		clearTimeout(safetyTimer);
		release?.();
		await executor.close();
	}
});

test("Pi truncates large Computer Use text and saves the complete output privately in tmp", async () => {
	const { toPiContent } = await import("../integrations/pi/index.ts");
	const original = "x".repeat(60 * 1024);
	const rendered = await toPiContent([
		{ type: "text", text: original },
		{ type: "image", data: "image-data", mimeType: "image/png" },
	]);
	assert.ok(rendered.fullOutputPath);
	try {
		assert.equal(await readFile(rendered.fullOutputPath, "utf8"), original);
		assert.equal((await stat(rendered.fullOutputPath)).mode & 0o777, 0o600);
		assert.equal((await stat(path.dirname(rendered.fullOutputPath))).mode & 0o777, 0o700);
		assert.deepEqual(await readdir(path.dirname(rendered.fullOutputPath)), ["output.txt"]);
		assert.match((rendered.content[0] as any).text, /Full output saved to:/);
		assert.deepEqual(rendered.content[1], { type: "image", data: "image-data", mimeType: "image/png" });
	} finally {
		await rm(path.dirname(rendered.fullOutputPath), { recursive: true, force: true });
	}
});
