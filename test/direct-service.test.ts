import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectBrokerCallError, type DirectBrokerResult } from "../src/direct-broker.ts";
import { executeDirectTool, type DirectServiceDependencies } from "../src/direct-service.ts";
import type { CuaReplArguments, CuaReplTool } from "../src/tools.ts";

function brokerResult(content = "ok", isError = false): DirectBrokerResult {
	return {
		content: [{ type: "text", text: content }],
		isError,
		brokerVersion: "test-app-server",
		clientBuild: "test-client",
		elicitationRequests: 0,
		modelTurnsStarted: 0,
		ephemeralThread: true,
		brokerCleanupVerified: true,
	};
}

function deps(root: string, callTool: DirectServiceDependencies["callTool"]): DirectServiceDependencies {
	return { stateRoot: root, callTool };
}

test("direct service passes cua_repl arguments through unchanged and sizes the request timeout from timeout_ms", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-passthrough-test."));
	const calls: Array<{ tool: CuaReplTool; args: CuaReplArguments; timeoutMs?: number }> = [];
	try {
		const record: DirectServiceDependencies["callTool"] = async (tool, args, options) => {
			calls.push({ tool, args, timeoutMs: options?.timeoutMs });
			return brokerResult();
		};
		await executeDirectTool({ tool: "js", arguments: { code: 'await cua.getApp("/Applications/Alternate App.app")', title: "Opening", futureOption: true } }, deps(root, record));
		await executeDirectTool({ tool: "js", arguments: { code: "1", timeout_ms: 600_000 } }, deps(root, record));
		await executeDirectTool({ tool: "js_reset", arguments: {} }, deps(root, record));
		assert.deepEqual(calls, [
			{ tool: "js", args: { code: 'await cua.getApp("/Applications/Alternate App.app")', title: "Opening", futureOption: true }, timeoutMs: 120_000 },
			{ tool: "js", args: { code: "1", timeout_ms: 600_000 }, timeoutMs: 630_000 },
			{ tool: "js_reset", args: {}, timeoutMs: 120_000 },
		]);
		await assert.rejects(executeDirectTool({ tool: "turn_ended", arguments: {} }, deps(root, record)), /did not name a cua_repl tool/);
		assert.equal(calls.length, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("direct service forwards elicitation handling", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-elicit-test."));
	const onElicitation = async () => ({ action: "accept" as const, content: { choice: "allow" } });
	let observedOptions: Parameters<NonNullable<DirectServiceDependencies["callTool"]>>[2];
	try {
		await executeDirectTool({ tool: "js_reset", arguments: {} }, {
			...deps(root, async (_tool, _args, options) => {
				observedOptions = options;
				return brokerResult();
			}),
			onElicitation,
			supportsOpenAiFormElicitation: true,
		});
		assert.equal(observedOptions.onElicitation, onElicitation);
		assert.equal(observedOptions.supportsOpenAiFormElicitation, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("actions dispatch without wrapper prompts or contentful audit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-full-test."));
	let observed: { tool: CuaReplTool; args: CuaReplArguments } | undefined;
	const code = 'let app = await cua.getApp("TextEdit"); await app.typeText("arbitrary direct action");';
	try {
		const response = await executeDirectTool(
			{ tool: "js", arguments: { code } },
			deps(root, async (tool, args) => {
				observed = { tool, args };
				return brokerResult("typed");
			}),
		);
		assert.equal(response.isError, false);
		assert.deepEqual(observed, { tool: "js", args: { code } });
		const auditText = await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8");
		assert.doesNotMatch(auditText, /arbitrary direct action|TextEdit/);
		const audit = JSON.parse(auditText);
		assert.equal(audit.modelTurnsStarted, 0);
		assert.equal(audit.directCalls, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("broker failures preserve architecture evidence in audit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-broker-evidence-test."));
	try {
		await assert.rejects(
			executeDirectTool(
				{ tool: "js", arguments: { code: "await cua.getApp('TextEdit')" } },
				deps(root, async () => {
					throw new DirectBrokerCallError("model activity", true, undefined, {
						directCalls: 1,
						modelTurnsStarted: 1,
						ephemeralThread: true,
						elicitationRequests: 1,
						brokerVersion: "test-app-server",
						clientBuild: "test-client",
					});
				}),
			),
			/model activity/,
		);
		const audit = JSON.parse(await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8"));
		assert.equal(audit.directCalls, 1);
		assert.equal(audit.modelTurnsStarted, 1);
		assert.equal(audit.elicitationRequests, 1);
		assert.equal(audit.brokerCleanupVerified, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("official tool errors remain errors without entering audit content", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-error-test."));
	try {
		const response = await executeDirectTool(
			{ tool: "js", arguments: { code: "await cua.getApp('TextEdit')" } },
			deps(root, async () => brokerResult("Official denial details", true)),
		);
		assert.equal(response.isError, true);
		const auditText = await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8");
		const audit = JSON.parse(auditText);
		assert.equal(audit.outcome, "official_error");
		assert.ok(audit.resultBytes > 0);
		assert.doesNotMatch(auditText, /Official denial details/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
