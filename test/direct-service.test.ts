import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeDirectTool, type DirectServiceDependencies } from "../src/direct-service.ts";
import { DirectBrokerCallError, type DirectBrokerResult } from "../src/direct-broker.ts";

function brokerResult(content = "ok", isError = false): DirectBrokerResult {
	return {
		content: [{ type: "text", text: content }],
		isError,
		brokerVersion: "test-app-server",
		clientBuild: "test-client",
		durationMs: 10,
		elicitationRequests: 0,
		modelTurnsStarted: 0,
		ephemeralThread: true,
		brokerCleanupVerified: true,
	};
}

function deps(root: string, callTool: DirectServiceDependencies["callTool"]): DirectServiceDependencies {
	return { stateRoot: root, callTool };
}

test("direct service passes app selectors, key expressions, and additional arguments through unchanged", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-passthrough-test."));
	const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
	try {
		const callTool: NonNullable<DirectServiceDependencies["callTool"]> = async (method, args) => {
			calls.push({ method, args });
			return brokerResult("state");
		};
		await executeDirectTool({
			method: "press_key",
			arguments: { app: "/Applications/Alternate App.app", key: "CMD+A", futureOption: true },
		}, deps(root, callTool));
		assert.deepEqual(calls, [{
			method: "press_key",
			args: { app: "/Applications/Alternate App.app", key: "CMD+A", futureOption: true },
		}]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct service passes client elicitation handling through to the signed broker", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-elicit-test."));
	try {
		const onElicitation = async () => ({ action: "accept" as const, content: { choice: "allow" } });
		let observedOptions: unknown;
		const testDeps = deps(root, async (_method, _args, options) => {
			observedOptions = options;
			return brokerResult("state");
		});
		testDeps.onElicitation = onElicitation;
		testDeps.supportsOpenAiFormElicitation = true;
		await executeDirectTool({ method: "list_apps", arguments: {} }, testDeps);
		assert.equal((observedOptions as any).onElicitation, onElicitation);
		assert.equal((observedOptions as any).supportsOpenAiFormElicitation, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct service does not serialize concurrent calls", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-concurrency-test."));
	let entered = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	try {
		const callTool = async () => {
			entered += 1;
			if (entered === 2) release();
			await held;
			return brokerResult();
		};
		await Promise.all([
			executeDirectTool({ method: "get_app_state", arguments: { app: "TextEdit" } }, deps(root, callTool)),
			executeDirectTool({ method: "get_app_state", arguments: { app: "TextEdit" } }, deps(root, callTool)),
		]);
		assert.equal(entered, 2);
	} finally {
		release?.();
		await rm(root, { recursive: true, force: true });
	}
});

test("no-permissions dispatches mutating methods without a wrapper gate or prompt", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-full-test."));
	let observed: unknown;
	try {
		const response = await executeDirectTool(
			{ method: "type_text", arguments: { app: "TextEdit", text: "arbitrary direct action" } },
			deps(root, async (method, args) => { observed = { method, args }; return brokerResult("typed"); }),
		);
		assert.equal(response.ok, true);
		assert.deepEqual(observed, { method: "type_text", args: { app: "TextEdit", text: "arbitrary direct action" } });
		const auditText = await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8");
		assert.doesNotMatch(auditText, /arbitrary direct action|TextEdit/);
		const audit = JSON.parse(auditText.trim());
		assert.equal(audit.permissionMode, "no-permissions");
		assert.equal(audit.authorization, "no_permissions_unrestricted");
		assert.equal(audit.modelTurnsStarted, 0);
		assert.equal(audit.directCalls, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("broker failures preserve content-safe architecture evidence in audit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-broker-evidence-test."));
	try {
		await assert.rejects(
			executeDirectTool(
				{ method: "get_app_state", arguments: { app: "TextEdit" } },
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
		const audit = JSON.parse((await readFile(path.join(root, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "broker_failed");
		assert.equal(audit.directCalls, 1);
		assert.equal(audit.modelTurnsStarted, 1);
		assert.equal(audit.ephemeralThread, true);
		assert.equal(audit.elicitationRequests, 1);
		assert.equal(audit.brokerCleanupVerified, true);
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
