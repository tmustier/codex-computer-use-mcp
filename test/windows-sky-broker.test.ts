import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import {
	DirectBrokerCallError,
	type DirectBrokerElicitationRequest,
	type DirectBrokerElicitationResponse,
} from "../src/direct-broker.ts";
import type { DirectToolArguments, JsonObject, JsonValue } from "../src/tools.ts";
import {
	approvalElicitation,
	callOfficialWindowsTool,
	clearSessionApprovals,
	createOfficialWindowsToolSession,
	windowsResultContent,
	type WindowsSkyClient,
	type WindowsSkyRuntime,
} from "../src/windows-sky-broker.ts";
import type { WindowsDirectMethod } from "../src/windows-tools.ts";

const window = { app: "Chrome", id: 7, title: "Tab" };
const screenshot = { id: "shot-0", zIndex: 0, width: 10, height: 5, originX: 1, originY: 2, url: "data:image/png;base64,AAAA" };

function fakeClient(overrides: Partial<WindowsSkyClient> = {}) {
	const calls: Array<{ method: WindowsDirectMethod; args: DirectToolArguments }> = [];
	let closed = 0;
	const record = (method: WindowsDirectMethod) => async (args: DirectToolArguments): Promise<JsonValue> => {
		calls.push({ method, args });
		return null;
	};
	const client: WindowsSkyClient = {
		async close() { closed += 1; },
		list_apps: async (args) => {
			calls.push({ method: "list_apps", args });
			return [{ id: "Chrome", displayName: "Google Chrome", isRunning: true, windows: [window] }, { id: "notepad.exe", windows: [] }];
		},
		list_windows: record("list_windows"),
		get_window: record("get_window"),
		launch_app: record("launch_app"),
		get_window_state: async (args) => {
			calls.push({ method: "get_window_state", args });
			return { window: args.window ?? null, screenshots: [screenshot], accessibility: { tree: "[0] Window\n[1] Button", focused_element: "[1] Button" } };
		},
		click: record("click"),
		press_key: record("press_key"),
		type_text: record("type_text"),
		scroll: record("scroll"),
		set_value: record("set_value"),
		drag: record("drag"),
		perform_secondary_action: record("perform_secondary_action"),
		activate_window: record("activate_window"),
		...overrides,
	};
	const turnsEnded: JsonObject[] = [];
	const runtime: WindowsSkyRuntime = { client, async endTurn(turnMeta) { turnsEnded.push(turnMeta); } };
	return { client, runtime, calls, turnsEnded, closed: () => closed };
}

function testSession(runtime: WindowsSkyRuntime, turnIdleMs = 50) {
	return createOfficialWindowsToolSession({ skipSignatureVerification: true, loadRuntime: async () => runtime, turnIdleMs });
}

interface NodeReplHost {
	requestMeta: JsonObject;
	createElicitation(request: JsonValue): Promise<DirectBrokerElicitationResponse>;
}

function nodeReplHost(): NodeReplHost {
	// SAFETY: the broker installed its node_repl host shim on globalThis when the test session was created.
	return (globalThis as { nodeRepl?: NodeReplHost }).nodeRepl!;
}

test("Windows session calls the official client with the caller's arguments and returns the official result", async () => {
	const { runtime, calls, closed } = fakeClient();
	const session = await testSession(runtime);
	const apps = await session.call("list_apps", {});
	assert.equal(apps.isError, false);
	assert.equal(apps.modelTurnsStarted, 0);
	assert.deepEqual(apps.content, [{ type: "text", text: 'Google Chrome — Chrome [running] — windows: 7 — Chrome — "Tab"\nnotepad.exe' }]);
	assert.deepEqual(apps.structuredContent, {
		apps: [{ id: "Chrome", displayName: "Google Chrome", isRunning: true, windows: [window] }, { id: "notepad.exe", windows: [] }],
	});

	const state = await session.call("get_window_state", { window, include_text: true });
	assert.deepEqual(state.content, [
		{ type: "text", text: 'window: 7 — Chrome — "Tab"\nscreenshot shot-0: 10x5 at (1, 2) z=0\nfocused_element: [1] Button\naccessibility tree:\n[0] Window\n[1] Button' },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
	]);
	assert.deepEqual(state.structuredContent, {
		window,
		accessibility: { tree: "[0] Window\n[1] Button", focused_element: "[1] Button" },
		screenshots: [{ id: "shot-0", zIndex: 0, width: 10, height: 5, originX: 1, originY: 2, image: { type: "image", data: "AAAA", mimeType: "image/png" } }],
	});

	const click = await session.call("click", { window, element_index: 3, futureOption: true });
	assert.deepEqual(click.content, [{ type: "text", text: "ok" }]);
	assert.equal(click.structuredContent, undefined);
	assert.deepEqual(calls[2], { method: "click", args: { window, element_index: 3, futureOption: true } });
	assert.equal(closed(), 0);
	await session.close();
	assert.equal(closed(), 1);
	await assert.rejects(session.call("list_apps", {}), /session is closed/);
});

test("official app approvals reach the caller as elicitations and the response returns unchanged", async () => {
	let received: JsonValue = null;
	const approval = {
		message: "Allow Codex to use Notepad?",
		meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { app: "notepad.exe" } },
	};
	const { runtime } = fakeClient({
		get_window_state: async (args) => {
			received = await nodeReplHost().createElicitation(approval);
			return { window: args.window ?? null, screenshots: [], accessibility: null };
		},
	});
	const session = await testSession(runtime);
	const requests: DirectBrokerElicitationRequest[] = [];
	const result = await session.call("get_window_state", { window }, {
		onElicitation: async (request) => {
			requests.push(request);
			return { action: "accept", content: { persist: "always" } };
		},
	});
	assert.equal(result.isError, false);
	assert.equal(result.elicitationRequests, 1);
	assert.equal(requests[0].mode, "form");
	assert.equal(requests[0].message, "Allow Codex to use Notepad?");
	assert.deepEqual(requests[0].requestedSchema, {
		type: "object",
		properties: { persist: { type: "string", enum: ["session", "always"], description: "How long the approval lasts" } },
		required: ["persist"],
	});
	assert.deepEqual(requests[0]._meta, approval.meta);
	assert.deepEqual(received, { action: "accept", content: { persist: "always" } });
	await session.close();

	const headless = await testSession(runtime);
	await headless.call("get_window_state", { window });
	assert.deepEqual(received, { action: "cancel" });
	await headless.close();
});

// The helper names apps by its own id (chrome.exe); windows name them differently.
const helperAppIds = new Map([
	["Chrome", "chrome.exe"],
	["process:E:\\apps\\electron\\electron.exe", "electron.exe"],
	["Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"],
]);

function approvingClient() {
	const asked: string[] = [];
	const fake = fakeClient({
		get_window_state: async (args) => {
			const host = nodeReplHost();
			const target = z.object({ window: z.object({ app: z.string() }) }).parse(args).window.app;
			const helperApp = helperAppIds.get(target) ?? target;
			if (host.requestMeta["x-oai-cua-approved-app"] !== helperApp) {
				asked.push(helperApp);
				const answer = await host.createElicitation({
					message: `Allow Codex to use ${helperApp}?`,
					meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { app: helperApp } },
				});
				if (answer.action !== "accept") throw new Error(`Computer Use was not approved to use ${helperApp}`);
			}
			return { window: args.window ?? null, screenshots: [], accessibility: null };
		},
	});
	return { ...fake, asked };
}

const neverAsk = async (): Promise<DirectBrokerElicitationResponse> => { throw new Error("an approved app must not be asked again"); };

test("session approvals mark later requests with the helper's own app id", async () => {
	clearSessionApprovals();
	const { runtime, asked } = approvingClient();
	const session = await testSession(runtime);
	const approve = async () => ({ action: "accept" as const, content: { persist: "session" } });
	const chrome = { app: "Chrome", id: 1 };
	const electron = { app: "process:E:\\apps\\electron\\electron.exe", id: 2 };
	const first = await session.call("get_window_state", { window: chrome }, { onElicitation: approve });
	assert.equal(first.isError, false);
	assert.equal(first.elicitationRequests, 1);
	const second = await session.call("get_window_state", { window: chrome }, { onElicitation: neverAsk });
	assert.equal(second.isError, false);
	assert.equal(second.elicitationRequests, 0);
	assert.equal(nodeReplHost().requestMeta["x-oai-cua-approved-app"], "chrome.exe");
	await session.call("get_window_state", { window: electron }, { onElicitation: approve });
	const electronAgain = await session.call("get_window_state", { window: electron }, { onElicitation: neverAsk });
	assert.equal(electronAgain.elicitationRequests, 0);
	const declined = await session.call("get_window_state", { window: { app: "other.exe", id: 3 } }, { onElicitation: async () => ({ action: "decline" }) });
	assert.equal(declined.isError, true);
	assert.deepEqual(asked, ["chrome.exe", "electron.exe", "other.exe"]);
	await session.close();

	// Session approvals outlive one helper session: the next session does not ask again.
	const next = await testSession(runtime);
	const later = await next.call("get_window_state", { window: chrome }, { onElicitation: neverAsk });
	assert.equal(later.elicitationRequests, 0);
	await next.close();
});

test("always approvals persist in the state directory and survive a new process", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "windows-approvals-test."));
	const configPath = path.join(stateRoot, "config.json");
	try {
		clearSessionApprovals();
		const { runtime } = approvingClient();
		const session = await createOfficialWindowsToolSession({ skipSignatureVerification: true, loadRuntime: async () => runtime, turnIdleMs: 50, configPath });
		const chrome = { app: "Chrome", id: 1 };
		await session.call("get_window_state", { window: chrome }, { onElicitation: async () => ({ action: "accept", content: { persist: "always" } }) });
		await session.close();
		const stored = JSON.parse(await readFile(path.join(stateRoot, "windows-approvals.json"), "utf8"));
		assert.deepEqual(stored, { version: 1, approvals: { Chrome: "chrome.exe", "chrome.exe": "chrome.exe" } });

		clearSessionApprovals(); // a new process starts without session memory
		const next = await createOfficialWindowsToolSession({ skipSignatureVerification: true, loadRuntime: async () => runtime, turnIdleMs: 50, configPath });
		const later = await next.call("get_window_state", { window: chrome }, { onElicitation: neverAsk });
		assert.equal(later.isError, false);
		assert.equal(later.elicitationRequests, 0);
		await next.close();
	} finally {
		clearSessionApprovals();
		await rm(stateRoot, { recursive: true, force: true });
	}
});

test("helper rejections are official errors while helper exits are broker failures", async () => {
	const { runtime, closed } = fakeClient({
		click: async () => { throw new Error("Computer Use was not approved to use Notepad"); },
		list_apps: async () => { throw new Error("computer-use helper exited with exit code 1"); },
	});
	const session = await testSession(runtime);
	const denied = await session.call("click", { window, x: 1, y: 1 });
	assert.equal(denied.isError, true);
	assert.deepEqual(denied.content, [{ type: "text", text: "Computer Use was not approved to use Notepad" }]);
	await assert.rejects(session.call("list_apps", {}), (error) => error instanceof DirectBrokerCallError && error.cleanupVerified === false && error.directCalls === 1);
	await assert.rejects(session.close(), /helper exited/);
	assert.equal(closed(), 1);
});

test("cancellation closes the helper and rejects the pending call", async () => {
	const controller = new AbortController();
	const { runtime, closed } = fakeClient({ get_window_state: () => new Promise<JsonValue>(() => undefined) });
	const session = await testSession(runtime);
	const pending = session.call("get_window_state", { window }, { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	await assert.rejects(session.close(), /cancelled/);
	assert.equal(closed(), 1);
});

test("one-shot Windows calls close the helper and report verified cleanup", async () => {
	const { runtime, closed } = fakeClient();
	const result = await callOfficialWindowsTool("list_apps", {}, { skipSignatureVerification: true, loadRuntime: async () => runtime });
	assert.equal(result.isError, false);
	assert.equal(result.brokerCleanupVerified, true);
	assert.equal(closed(), 1);
});

test("the helper turn ends after the idle period and later calls start a new turn", async () => {
	const fake = fakeClient();
	const session = await testSession(fake.runtime, 30);
	await session.call("list_windows", {});
	await session.call("list_windows", {});
	assert.equal(fake.turnsEnded.length, 0, "consecutive calls share one turn");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(fake.turnsEnded.length, 1);
	const first = fake.turnsEnded[0];
	assert.match(String(first.turn_id), /^[0-9a-f-]{36}$/);
	await session.call("list_windows", {});
	const meta = nodeReplHost().requestMeta;
	assert.equal(meta.session_id, first.session_id);
	assert.notEqual(meta.turn_id, first.turn_id);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(fake.turnsEnded.length, 2);
	await session.call("list_windows", {});
	await session.close();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(fake.turnsEnded.length, 2, "closing the helper ends its turn without a separate end_turn");
	assert.equal(fake.closed(), 1);
});

test("approval and result conversion tolerate minimal official payloads", () => {
	const fallback = approvalElicitation(null);
	assert.equal(fallback.mode, "form");
	assert.equal(fallback.message, "Allow Computer Use to use this app?");
	assert.deepEqual(fallback.requestedSchema, {
		type: "object",
		properties: { persist: { type: "string", enum: ["session"], description: "How long the approval lasts" } },
		required: ["persist"],
	});

	assert.deepEqual(windowsResultContent("list_windows", [window]), {
		content: [{ type: "text", text: '7 — Chrome — "Tab"' }],
		structuredContent: { windows: [window] },
	});
	assert.deepEqual(windowsResultContent("activate_window", undefined), { content: [{ type: "text", text: "ok" }] });
	const state = windowsResultContent("get_window_state", { window: { app: "x", id: 1 }, screenshots: [{ id: "s", url: "not-a-data-url" }] });
	assert.deepEqual(state.content, [{ type: "text", text: "window: 1 — x\nscreenshot s: z=0" }]);
	assert.deepEqual(state.structuredContent, { window: { app: "x", id: 1 }, accessibility: null, screenshots: [{ id: "s", image: null }] });
	assert.deepEqual(windowsResultContent("list_apps", "unexpected"), {
		content: [{ type: "text", text: '"unexpected"' }],
		structuredContent: "unexpected",
	});
});
