import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveConfig } from "../src/config.ts";
import { executeDirectTool, DirectPolicyError, type DirectServiceDependencies } from "../src/direct-service.ts";
import type { DirectBrokerResult } from "../src/direct-broker.ts";

function brokerResult(content = "ok", isError = false): DirectBrokerResult {
	return {
		content: [{ type: "text", text: content }],
		isError,
		brokerVersion: "test-app-server",
		clientBuild: "test-client",
		durationMs: 10,
		approvalRequests: 0,
		modelTurnsStarted: 0,
		ephemeralThread: true,
		brokerCleanupVerified: true,
	};
}

function deps(root: string, callTool: DirectServiceDependencies["callTool"], becameFrontmost = false): DirectServiceDependencies {
	return {
		stateRoot: root,
		callTool,
		resolveIdentity: (app) => ({ bundleId: app === "TextEdit" ? "com.apple.TextEdit" : app, leaseId: (app === "TextEdit" ? "com.apple.TextEdit" : app).toLowerCase(), verifiedSystemDictionary: false }),
		frontmost: () => "com.google.Chrome",
		frontmostAsync: async () => "com.google.Chrome",
		watchFocus: async () => ({ healthy: () => true, becameFrontmost: () => becameFrontmost, stop: async () => undefined }),
		acquireLock: async (_state, app, runId) => ({ path: "test", owner: { runId, pid: process.pid, app, startedAt: new Date().toISOString() }, release: async () => undefined }),
	};
}

test("safe mode directly permits only read methods and canonicalizes app identity", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-safe-test."));
	const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
	try {
		const callTool: NonNullable<DirectServiceDependencies["callTool"]> = async (method, args) => {
			calls.push({ method, args });
			return brokerResult("state");
		};
		const listed = await executeDirectTool({ method: "list_apps", arguments: {} }, deps(root, callTool));
		assert.equal(listed.ok, true);
		const state = await executeDirectTool({ method: "get_app_state", arguments: { app: "TextEdit" } }, deps(root, callTool));
		assert.equal(state.ok, true);
		assert.deepEqual(calls, [
			{ method: "list_apps", args: {} },
			{ method: "get_app_state", args: { app: "com.apple.TextEdit" } },
		]);
		assert.equal(state.details.modelTurnsStarted, 0);
		assert.equal(state.details.ephemeralRuntimeContext, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("safe mode rejects mutation before identity resolution or broker dispatch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-reject-test."));
	let dispatched = false;
	try {
		await assert.rejects(
			executeDirectTool(
				{ method: "click", arguments: { app: "TextEdit", element_index: "button-1" } },
				{ stateRoot: root, callTool: async () => { dispatched = true; return brokerResult(); } },
			),
			DirectPolicyError,
		);
		assert.equal(dispatched, false);
		const audit = JSON.parse((await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "policy_rejected");
		assert.equal(audit.directCalls, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("full-permissions has no wrapper app, intent, or action gate", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-full-test."));
	let observed: unknown;
	try {
		await saveConfig(root, { version: 1, permissionMode: "full-permissions" });
		const response = await executeDirectTool(
			{ method: "type_text", arguments: { app: "TextEdit", text: "arbitrary direct action" } },
			deps(root, async (method, args) => { observed = { method, args }; return brokerResult("typed"); }),
		);
		assert.equal(response.ok, true);
		assert.deepEqual(observed, { method: "type_text", args: { app: "com.apple.TextEdit", text: "arbitrary direct action" } });
		const auditText = await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8");
		assert.doesNotMatch(auditText, /arbitrary direct action/);
		const audit = JSON.parse(auditText.trim());
		assert.equal(audit.authorization, "full_permissions_config");
		assert.equal(audit.modelTurnsStarted, 0);
		assert.equal(audit.directCalls, 1);
		assert.equal(audit.backgroundPreserved, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("focus telemetry fails closed after a completed direct action", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-focus-test."));
	try {
		await saveConfig(root, { version: 1, permissionMode: "full-permissions" });
		await assert.rejects(
			executeDirectTool(
				{ method: "press_key", arguments: { app: "TextEdit", key: "ESC" } },
				deps(root, async () => brokerResult("pressed"), true),
			),
			/background-safe/,
		);
		const audit = JSON.parse((await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "focus_violation");
		assert.equal(audit.backgroundPreserved, false);
		assert.equal(audit.directCalls, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("official tool errors remain errors with complete metadata-only audit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-error-test."));
	try {
		const response = await executeDirectTool(
			{ method: "get_app_state", arguments: { app: "TextEdit" } },
			deps(root, async () => brokerResult("Official denial details", true)),
		);
		assert.equal(response.isError, true);
		const audit = JSON.parse((await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "official_error");
		assert.equal(audit.resultBytes > 0, true);
		assert.doesNotMatch(JSON.stringify(audit), /Official denial details/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
