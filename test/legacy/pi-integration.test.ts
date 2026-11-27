import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	COMPUTER_USE_NAMESPACE,
	WINDOWS_COMPUTER_USE_NAMESPACE,
	computerUseToolName,
	registerLegacyComputerUse,
} from "../../integrations/pi/legacy.ts";
import { handleOfficialElicitation } from "../../integrations/pi/content.ts";
import type { DirectServiceDependencies } from "../../src/legacy/direct-service.ts";
import { MAC_PLATFORM, WINDOWS_PLATFORM, type ComputerUsePlatform } from "../../src/legacy/platform.ts";
import { approvalElicitation } from "../../src/legacy/windows-sky-broker.ts";
import type { DirectBrokerResult } from "../../src/legacy/direct-broker.ts";
import { LegacySessionExecutor as DirectSessionExecutor } from "../../src/legacy/session-executor.ts";
import {
	COMPUTER_USE_METHODS,
	TOOL_INPUT_SCHEMAS,
	TOOL_METADATA,
	type DirectMethod,
	type DirectToolArguments,
	type JsonValue,
} from "../../src/legacy/tools.ts";

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


interface TestUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string): void;
}

interface TestToolContext {
	hasUI: boolean;
	ui: TestUi;
}

interface TestEventContext {
	ui: Pick<TestUi, "notify">;
}

type TestEvent = Record<string, never>;
type TestHandler = (event: TestEvent, ctx: TestEventContext) => void | Promise<void>;

interface RegisteredTool {
	name: string;
	description: string;
	parameters: unknown;
	outputSchema?: unknown;
	exposure?: string;
	namespace?: { name: string; instructions?: string };
	annotations?: unknown;
	execute(toolCallId: string, params: DirectToolArguments, signal: AbortSignal | undefined, onUpdate: undefined, ctx: TestToolContext): Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		structuredContent?: JsonValue;
	}>;
}

function loadAdapter(session: { execute: DirectSessionExecutor["execute"]; close(): Promise<void> }, active = ["read"], platform: ComputerUsePlatform = MAC_PLATFORM) {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, TestHandler>();
	const activeTools = new Set(active);
	let activeToolsChanged = false;
	const fakePi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
		on(name: string, handler: TestHandler) { handlers.set(name, handler); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools() { activeToolsChanged = true; },
	};
	// SAFETY: this focused adapter test implements every ExtensionAPI member the adapter uses.
	registerLegacyComputerUse(fakePi as any, path.join(os.tmpdir(), "legacy-pi-state"), session, platform);
	const tool = (method: DirectMethod) => tools.find((candidate) => candidate.name === computerUseToolName(method))!;
	return { tools, commands, handlers, tool, activeToolsChanged: () => activeToolsChanged };
}

const noUi = { notify() {} };
const headlessContext: TestToolContext = {
	hasUI: false,
	ui: { async select() { return undefined; }, async editor() { return undefined; }, notify() {} },
};

test("Pi registers the ten official methods as codemode tools without changing the active tools", async () => {
	let closed = 0;
	const { tools, commands, handlers, activeToolsChanged } = loadAdapter({
		async execute() { return { isError: false, content: [] }; },
		async close() { closed += 1; },
	});
	assert.deepEqual(commands, []);
	assert.deepEqual(tools.map((tool) => tool.name), COMPUTER_USE_METHODS.map(computerUseToolName));
	for (const [index, method] of COMPUTER_USE_METHODS.entries()) {
		const tool = tools[index];
		assert.equal(tool.exposure, "codemode");
		assert.equal(tool.namespace, COMPUTER_USE_NAMESPACE);
		assert.equal(tool.description, TOOL_METADATA[method].description);
		assert.deepEqual(tool.parameters, TOOL_INPUT_SCHEMAS[method]);
		assert.deepEqual(tool.annotations, TOOL_METADATA[method].annotations);
		assert.equal(tool.outputSchema !== undefined, method === "get_app_state", method);
	}
	assert.match(COMPUTER_USE_NAMESPACE.instructions ?? "", /tools\.computer_use_get_app_state/);
	handlers.get("session_start")?.({}, { ui: noUi });
	assert.equal(activeToolsChanged(), false);
	await handlers.get("agent_settled")?.({}, { ui: noUi });
	await handlers.get("session_shutdown")?.({}, { ui: noUi });
	assert.equal(closed, 2);
});

test("codemode calls share one session and return structured app state", async () => {
	const calls: Array<{ method: DirectMethod; args: DirectToolArguments; supportsOpenAiFormElicitation?: boolean }> = [];
	const { tool } = loadAdapter({
		async execute(method, args, dependencies) {
			calls.push({ method, args, supportsOpenAiFormElicitation: dependencies.supportsOpenAiFormElicitation });
			if (method !== "get_app_state") return { isError: false, content: [] };
			return {
				isError: false,
				content: [
					{ type: "text", text: "AX tree" },
					{ type: "image", data: "png-data", mimeType: "image/png" },
				],
			};
		},
		async close() {},
	});
	const state = await tool("get_app_state").execute("1", { app: "TextEdit" }, undefined, undefined, headlessContext);
	assert.deepEqual(state.structuredContent, {
		app: "TextEdit",
		text: "AX tree",
		screenshot: { type: "image", data: "png-data", mimeType: "image/png" },
	});
	assert.deepEqual(state.content, [
		{ type: "text", text: "AX tree" },
		{ type: "image", data: "png-data", mimeType: "image/png" },
	]);
	const click = await tool("click").execute("2", { app: "TextEdit", element_index: "7" }, undefined, undefined, headlessContext);
	assert.equal(click.structuredContent, undefined);
	await tool("type_text").execute("3", { app: "TextEdit", text: "hello" }, undefined, undefined, headlessContext);
	assert.deepEqual(calls.map((call) => call.method), ["get_app_state", "click", "type_text"]);
	assert.deepEqual(calls[1].args, { app: "TextEdit", element_index: "7" });
	assert.equal(calls.every((call) => call.supportsOpenAiFormElicitation === true), true);
});

test("list_apps returns the official text inventory unchanged", async () => {
	const inventory = "Notes — Beta — /Applications/Notes Beta.app/ — example.NotesBeta [running]";
	const { tool } = loadAdapter({
		async execute() { return { isError: false, content: [{ type: "text", text: inventory }] }; },
		async close() {},
	});
	const result = await tool("list_apps").execute("1", {}, undefined, undefined, headlessContext);
	assert.deepEqual(result.content, [{ type: "text", text: inventory }]);
});

test("an official error rejects the call with the official text", async () => {
	const { tool } = loadAdapter({
		async execute() { return { isError: true, content: [{ type: "text", text: "element not found" }] }; },
		async close() {},
	});
	await assert.rejects(
		tool("click").execute("1", { app: "TextEdit", element_index: "missing" }, undefined, undefined, headlessContext),
		/^Error: element not found$/,
	);
});

test("Pi warns once when neither codemode nor a Computer Use tool is active", async () => {
	const session = { async execute() { return { isError: false, content: [] }; }, async close() {} };
	const notices: string[] = [];
	const ctx = { ui: { notify(message: string) { notices.push(message); } } };

	const inactive = loadAdapter(session);
	inactive.handlers.get("session_start")?.({}, ctx);
	inactive.handlers.get("before_agent_start")?.({}, ctx);
	inactive.handlers.get("before_agent_start")?.({}, ctx);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /\+codemode/);

	for (const active of [["read", "codemode"], ["read", computerUseToolName("click")]]) {
		const reachable = loadAdapter(session, active);
		reachable.handlers.get("session_start")?.({}, ctx);
		reachable.handlers.get("before_agent_start")?.({}, ctx);
	}
	assert.equal(notices.length, 1);
});

test("broker setup failures remain audited", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-direct-setup-audit-test."));
	try {
		const executor = new DirectSessionExecutor({
		platform: MAC_PLATFORM,
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
		platform: MAC_PLATFORM,
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
		platform: MAC_PLATFORM,
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
		platform: MAC_PLATFORM,
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

test("Pi registers the official Windows methods on Windows hosts and passes structured results through", async () => {
	const calls: Array<{ method: DirectMethod; args: DirectToolArguments; platform?: ComputerUsePlatform }> = [];
	const window = { app: "Chrome", id: 7, title: "Tab" };
	const image = { type: "image", data: "png-data", mimeType: "image/png" };
	const { tools, tool } = loadAdapter({
		async execute(method, args, dependencies: DirectServiceDependencies) {
			calls.push({ method, args, platform: dependencies.platform });
			if (method === "get_window_state") {
				return {
					isError: false,
					content: [{ type: "text", text: "window: 7 — Chrome" }, image],
					structuredContent: { window, accessibility: { tree: "[0] Window" }, screenshots: [{ id: "shot-0", zIndex: 0, image }] },
				};
			}
			if (method === "list_apps") return { isError: false, content: [{ type: "text", text: "Chrome" }], structuredContent: { apps: [] } };
			return { isError: false, content: [{ type: "text", text: "ok" }] };
		},
		async close() {},
	}, ["read"], WINDOWS_PLATFORM);
	assert.deepEqual(tools.map((item) => item.name), WINDOWS_PLATFORM.methods.map(computerUseToolName));
	for (const item of tools) {
		assert.equal(item.namespace, WINDOWS_COMPUTER_USE_NAMESPACE);
		assert.equal(item.exposure, "codemode");
	}
	const structuredMethods = ["list_apps", "list_windows", "get_window", "get_window_state"];
	assert.deepEqual(
		tools.filter((item) => item.outputSchema !== undefined).map((item) => item.name),
		WINDOWS_PLATFORM.methods.filter((method) => structuredMethods.includes(method)).map(computerUseToolName),
	);
	assert.match(WINDOWS_COMPUTER_USE_NAMESPACE.instructions ?? "", /tools\.computer_use_get_window_state/);

	const state = await tool("get_window_state").execute("1", { window, include_text: true }, undefined, undefined, headlessContext);
	assert.deepEqual(state.content, [{ type: "text", text: "window: 7 — Chrome" }, image]);
	assert.deepEqual(state.structuredContent, { window, accessibility: { tree: "[0] Window" }, screenshots: [{ id: "shot-0", zIndex: 0, image }] });
	const apps = await tool("list_apps").execute("2", {}, undefined, undefined, headlessContext);
	assert.deepEqual(apps.structuredContent, { apps: [] });
	const click = await tool("click").execute("3", { window, element_index: 7 }, undefined, undefined, headlessContext);
	assert.equal(click.structuredContent, undefined);
	assert.deepEqual(calls.map((call) => call.method), ["get_window_state", "list_apps", "click"]);
	assert.deepEqual(calls[2].args, { window, element_index: 7 });
	assert.equal(calls.every((call) => call.platform === WINDOWS_PLATFORM), true);
});

test("Pi answers official Windows app approvals with the chosen persistence", async () => {
	const request = approvalElicitation({
		message: "Allow Codex to use Notepad?",
		meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { app: "notepad.exe" } },
	});
	const ask = (answer: string | undefined) => {
		let title = "";
		let options: string[] = [];
		const response = handleOfficialElicitation(request, {
			hasUI: true,
			ui: {
				async select(selectTitle, selectOptions) { title = selectTitle; options = selectOptions; return answer; },
				async editor() { throw new Error("approvals never open the editor"); },
				notify() {},
			},
		}, async () => false);
		return response.then((value) => ({ value, title, options }));
	};
	const always = await ask("Always allow");
	assert.equal(always.title, "Allow Codex to use Notepad?");
	assert.deepEqual(always.options, ["Allow for this session", "Always allow", "Decline", "Cancel"]);
	assert.deepEqual(always.value, { action: "accept", content: { persist: "always" } });
	assert.deepEqual((await ask("Allow for this session")).value, { action: "accept", content: { persist: "session" } });
	assert.deepEqual((await ask("Decline")).value, { action: "decline" });
	assert.deepEqual((await ask(undefined)).value, { action: "cancel" });
});
