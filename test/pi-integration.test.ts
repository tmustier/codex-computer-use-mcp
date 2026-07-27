import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXPECTED_OFFICIAL_INPUT_SCHEMAS, OFFICIAL_METHODS, OFFICIAL_TOOL_METADATA } from "../src/tools.ts";

test("Pi adapter registers all ten tools through one direct no-permissions session path", async () => {
	const source = await readFile("integrations/pi/index.ts", "utf8");
	assert.match(source, /const piName = `computer_use_\$\{method\}`/);
	for (const method of OFFICIAL_METHODS) assert.match(source, new RegExp(`\\b${method}: Type\\.Object`));
	for (const forbidden of [
		"runOfficialCodex",
		"buildPrompt",
		"reasoningEffort",
		"gpt-",
		"background_computer_use",
		"computer-use-mode",
		"saveConfig",
		"loadConfig",
		"ctx.ui.confirm",
		"ctx.ui.input",
		"full-permissions",
		"safe mode",
		"must not be used",
		"credentials",
		"authentication",
		"payments",
		"external messages",
		"destructive actions",
		"purpose-built",
		"confirmation",
		"policy gate",
	]) {
		assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	}
	assert.match(source, /OFFICIAL_TOOL_METADATA\[method\]\.description/);
	assert.match(source, /executeDirectTool/);
	assert.match(source, /onElicitation: \(request\) => handleOfficialElicitation/);
	assert.match(source, /supportsOpenAiFormElicitation: true/);
	assert.match(source, /Call computer_use_get_app_state once per assistant turn before interacting with an app/);
	assert.match(source, /new PiDirectSessionExecutor\(\)/);
	assert.match(source, /sessionExecutor\.execute/);
	assert.match(source, /pi\.on\("session_start", \(\) => setInitialComputerUseTools\(pi\)\)/);
	assert.match(source, /pi\.on\("session_shutdown", \(\) => sessionExecutor\.close\(\)\)/);
});

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

test("Pi runtime registration exposes the exact official contract for all ten tools", async () => {
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
	const active = new Set(["read", ...OFFICIAL_METHODS.map((method) => `computer_use_${method}`)]);
	adapter({
		registerTool(tool: typeof tools[number]) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
		on(name: string, handler: () => void) { handlers.set(name, handler); },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active.clear(); for (const name of names) active.add(name); },
	} as any);
	assert.deepEqual(commands, ["computer-use-status"]);
	assert.deepEqual(tools.map((tool) => tool.name).sort(), OFFICIAL_METHODS.map((method) => `computer_use_${method}`).sort());
	for (const method of OFFICIAL_METHODS) {
		const tool = tools.find((item) => item.name === `computer_use_${method}`)!;
		assert.equal(tool.description, OFFICIAL_TOOL_METADATA[method].description);
		assert.deepEqual(tool.parameters, EXPECTED_OFFICIAL_INPUT_SCHEMAS[method]);
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
			resolveIdentity: () => ({ bundleId: "com.apple.TextEdit", leaseId: "com.apple.textedit", verifiedSystemDictionary: false }),
			frontmost: () => "com.google.Chrome",
			frontmostAsync: async () => "com.google.Chrome",
			watchFocus: async () => ({ healthy: () => true, becameFrontmost: () => false, stop: async () => undefined }),
			acquireLock: async (_state: string, app: string, runId: string) => ({
				path: "test", owner: { runId, pid: process.pid, app, startedAt: new Date().toISOString() }, release: async () => undefined,
			}),
		} as any), /verified broker setup failed/);
		const audit = JSON.parse((await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "broker_failed");
		assert.equal(audit.brokerCleanupVerified, false);
		assert.equal(audit.directCalls, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi direct executor reuses one signed client session for get_app_state and the following action", async () => {
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
	await executor.execute("press_key", { app: "com.google.Chrome", key: "ESC" }, {});
	assert.deepEqual(calls, [
		{ session: 1, method: "get_app_state" },
		{ session: 1, method: "press_key" },
	]);
	assert.equal(sessionsCreated, 1);
	assert.equal(sessionsClosed, 1, "the paired action closes the retained signed session");
});
