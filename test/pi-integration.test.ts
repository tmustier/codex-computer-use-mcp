import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import adapter, { handleOfficialElicitation, PI_TOOL_NAMES, toPiContent } from "../integrations/pi/index.ts";
import type { DirectBrokerResult } from "../src/direct-broker.ts";
import { officialToolDefinitions } from "../src/direct-service.ts";
import { DirectSessionExecutor } from "../src/session-executor.ts";
import type { CuaReplArguments, CuaReplTool, JsonValue } from "../src/tools.ts";

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

interface TestUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string): void;
}

interface TestToolContext {
	hasUI: boolean;
	ui: TestUi;
}

type TestHandler = (event: Record<string, never>, ctx: Record<string, never>) => void | Promise<void>;

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	exposure?: string;
	annotations?: unknown;
	execute(toolCallId: string, params: CuaReplArguments, signal: AbortSignal | undefined, onUpdate: undefined, ctx: TestToolContext): Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: JsonValue;
	}>;
}

type TestSession = Pick<DirectSessionExecutor, "execute" | "endTurn" | "close">;

function loadAdapter(session: TestSession) {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, TestHandler>();
	const fakePi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
		on(name: string, handler: TestHandler) { handlers.set(name, handler); },
	};
	// SAFETY: this focused adapter test implements every ExtensionAPI member the adapter uses.
	adapter(fakePi as any, session);
	const tool = (name: CuaReplTool) => tools.find((candidate) => candidate.name === PI_TOOL_NAMES[name])!;
	return { tools, commands, handlers, tool };
}

const headlessContext: TestToolContext = {
	hasUI: false,
	ui: { async select() { return undefined; }, async editor() { return undefined; }, notify() {} },
};

function testSession(overrides: Partial<TestSession> = {}): TestSession {
	return {
		async execute() { return { isError: false, content: [] }; },
		async endTurn() {},
		async close() {},
		...overrides,
	};
}

test("Pi registers the official cua_repl tools as ordinary tools and ends the turn when the agent settles", async () => {
	const events: string[] = [];
	const { tools, commands, handlers } = loadAdapter(testSession({
		async endTurn() { events.push("endTurn"); },
		async close() { events.push("close"); },
	}));
	assert.deepEqual(commands, ["computer-use-status"]);
	const official = officialToolDefinitions(process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use"));
	assert.deepEqual(tools.map((tool) => tool.name), ["cua_repl", "cua_repl_reset"]);
	for (const [index, definition] of official.tools.entries()) {
		const tool = tools[index]!;
		assert.equal(tool.exposure, undefined);
		assert.equal(tool.description, definition.description);
		assert.deepEqual(tool.parameters, definition.inputSchema);
		assert.deepEqual(tool.annotations, definition.annotations);
	}
	await handlers.get("agent_settled")?.({}, {});
	await handlers.get("session_shutdown")?.({}, {});
	assert.deepEqual(events, ["endTurn", "close"]);
});

test("cua_repl calls pass their arguments through and return text and images in order", async () => {
	const calls: Array<{ tool: CuaReplTool; args: CuaReplArguments; supportsOpenAiFormElicitation?: boolean }> = [];
	const { tool } = loadAdapter(testSession({
		async execute(name, args, dependencies) {
			calls.push({ tool: name, args, supportsOpenAiFormElicitation: dependencies.supportsOpenAiFormElicitation });
			return {
				isError: false,
				content: [
					{ type: "text", text: "AX tree" },
					{ type: "image", data: "png-data", mimeType: "image/png" },
				],
			};
		},
	}));
	const code = 'let app = await cua.getApp("TextEdit");';
	const state = await tool("js").execute("1", { code, title: "Opening TextEdit" }, undefined, undefined, headlessContext);
	assert.deepEqual(state.content, [
		{ type: "text", text: "AX tree" },
		{ type: "image", data: "png-data", mimeType: "image/png" },
	]);
	assert.equal(state.isError, false);
	await tool("js_reset").execute("2", {}, undefined, undefined, headlessContext);
	assert.deepEqual(calls.map((call) => [call.tool, call.args]), [["js", { code, title: "Opening TextEdit" }], ["js_reset", {}]]);
	assert.equal(calls.every((call) => call.supportsOpenAiFormElicitation === true), true);
});

test("an official error is returned as an error result that keeps its content", async () => {
	const { tool } = loadAdapter(testSession({
		async execute() {
			return { isError: true, content: [{ type: "text", text: "ReferenceError: app is not defined" }, { type: "image", data: "png", mimeType: "image/png" }] };
		},
	}));
	const result = await tool("js").execute("1", { code: "await app.click(3)" }, undefined, undefined, headlessContext);
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [
		{ type: "text", text: "ReferenceError: app is not defined" },
		{ type: "image", data: "png", mimeType: "image/png" },
	]);
});

test("broker setup failures remain audited", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-setup-audit-test."));
	try {
		const executor = new DirectSessionExecutor({
			createSession: async () => { throw new Error("verified broker setup failed"); },
		});
		await assert.rejects(
			executor.execute("js", { code: "1" }, { stateRoot: root }),
			/verified broker setup failed/,
		);
		const audit = JSON.parse(await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8"));
		assert.equal(audit.outcome, "broker_failed");
		assert.equal(audit.directCalls, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function fakeSession(log: string[], id: number, result = brokerResult("ok")) {
	return {
		async call(tool: CuaReplTool) { log.push(`${id}:${tool}`); return result; },
		async endTurn() { log.push(`${id}:endTurn`); },
		async close() { log.push(`${id}:close`); },
	};
}

test("retained sessions advertise only the caller's elicitation capability", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-session-capability-test."));
	const advertised: boolean[] = [];
	const createExecutor = () => new DirectSessionExecutor({
		createSession: async (options) => {
			advertised.push(options.supportsOpenAiFormElicitation === true);
			return fakeSession([], 0);
		},
	});
	const genericExecutor = createExecutor();
	const piExecutor = createExecutor();
	try {
		await genericExecutor.execute("js", { code: "1" }, { stateRoot: root });
		await piExecutor.execute("js", { code: "1" }, { stateRoot: root, supportsOpenAiFormElicitation: true });
		assert.deepEqual(advertised, [false, true]);
	} finally {
		await Promise.all([genericExecutor.close(), piExecutor.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("one session serves every call and turn, and a transport failure replaces it", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-session-test."));
	const log: string[] = [];
	let sessionsCreated = 0;
	let failNext = false;
	const executor = new DirectSessionExecutor({
		createSession: async () => {
			const id = ++sessionsCreated;
			const session = fakeSession(log, id);
			return {
				...session,
				async call(tool: CuaReplTool) {
					if (failNext) { failNext = false; log.push(`${id}:${tool}:transport-failed`); throw new Error("transport failed"); }
					log.push(`${id}:${tool}`);
					return brokerResult("ok");
				},
			};
		},
	});
	try {
		await executor.execute("js", { code: "let app = await cua.getApp('Chrome')" }, { stateRoot: root });
		await executor.execute("js", { code: "await app.click(3)" }, { stateRoot: root });
		await executor.endTurn();
		await executor.execute("js", { code: "await app.getAXState()" }, { stateRoot: root });
		failNext = true;
		await assert.rejects(executor.execute("js", { code: "1" }, { stateRoot: root }), /transport failed/);
		await executor.execute("js_reset", {}, { stateRoot: root });
		await executor.close();
		assert.deepEqual(log, ["1:js", "1:js", "1:endTurn", "1:js", "1:js:transport-failed", "1:close", "2:js_reset", "2:close"]);
	} finally {
		await executor.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("a quiet MCP session ends its turn but keeps its REPL", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-idle-test."));
	const log: string[] = [];
	const executor = new DirectSessionExecutor({ idleTurnEndMs: 10, createSession: async () => fakeSession(log, 1) });
	try {
		await executor.execute("js", { code: "1" }, { stateRoot: root });
		await new Promise((resolve) => setTimeout(resolve, 40));
		await executor.execute("js", { code: "2" }, { stateRoot: root });
		assert.deepEqual(log, ["1:js", "1:endTurn", "1:js"]);
	} finally {
		await executor.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi truncates aggregate text to a private spill file without spilling images", async () => {
	const first = "x".repeat(30 * 1024);
	const second = "y".repeat(30 * 1024);
	const original = `${first}\n\n${second}`;
	const rendered = await toPiContent([
		{ type: "text", text: first },
		{ type: "image", data: "first-image", mimeType: "image/png" },
		{ type: "text", text: second },
		{ type: "image", data: "second-image", mimeType: "image/png" },
	]);
	assert.ok(rendered.fullOutputPath);
	try {
		assert.equal(await readFile(rendered.fullOutputPath, "utf8"), original);
		assert.equal((await stat(rendered.fullOutputPath)).mode & 0o777, 0o600);
		assert.deepEqual(rendered.content.map((block) => block.type), ["text", "image", "text", "image"]);
		assert.deepEqual(rendered.content[0], { type: "text", text: first });
		assert.deepEqual(rendered.content[1], { type: "image", data: "first-image", mimeType: "image/png" });
		assert.match(rendered.content[2].type === "text" ? rendered.content[2].text : "", /^\n\n\[Official Computer Use text truncated:.*Full output saved to:/s);
		const returnedText = rendered.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		assert.ok(Buffer.byteLength(returnedText) < 55 * 1024);
		assert.deepEqual(rendered.content[3], { type: "image", data: "second-image", mimeType: "image/png" });
	} finally {
		await rm(path.dirname(rendered.fullOutputPath), { recursive: true, force: true });
	}
});
