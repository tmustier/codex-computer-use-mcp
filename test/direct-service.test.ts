import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { DirectBrokerCallError, type DirectBrokerResult } from "../src/direct-broker.ts";
import { executeDirectTool, type DirectServiceDependencies } from "../src/direct-service.ts";
import { TOOL_INPUT_SCHEMAS, type DirectMethod, type DirectToolArguments } from "../src/tools.ts";

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

test("element indices accept strings and integers but forward only strings to the official tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-indices."));
	const cases = [
		["click", {}],
		["perform_secondary_action", { action: "AXPress" }],
		["set_value", { value: "hello" }],
		["select_text", { text: "hello" }],
		["scroll", { direction: "down" }],
	] satisfies Array<[DirectMethod, DirectToolArguments]>;
	try {
		for (const [method, extra] of cases) {
			// Clients validate these advertised schemas before the service sees arguments.
			const validate = new AjvJsonSchemaValidator().getValidator(TOOL_INPUT_SCHEMAS[method]);
			for (const [input, expected] of [[7, "7"], [0, "0"], [-3, "-3"], ["007", "007"], ["node:42", "node:42"]] as const) {
				const args = { app: "com.apple.TextEdit", ...extra, element_index: input, futureOption: true };
				assert.equal(validate(args).valid, true, `${method}: ${input}`);
				const result = await executeDirectTool({ method, arguments: args }, deps(root, async (_method, actual) => {
					assert.deepEqual(actual, { ...args, element_index: expected });
					return brokerResult("accepted");
				}));
				assert.equal(result.content[0].text, "accepted");
				assert.equal(args.element_index, input);
			}
			for (const invalid of [1.5, true, null, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
				const args = { app: "TextEdit", ...extra, element_index: invalid };
				assert.equal(validate(args).valid, false, `${method}: ${JSON.stringify(invalid)}`);
				await assert.rejects(executeDirectTool({ method, arguments: args },
					deps(root, async () => { assert.fail("invalid index must not dispatch"); })), /did not match a tool schema/);
			}
		}
		const coordinates = { app: "TextEdit", x: 12, y: 34 };
		await executeDirectTool({ method: "click", arguments: coordinates }, deps(root, async (_method, actual) => {
			assert.deepEqual(actual, coordinates);
			return brokerResult();
		}));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("direct service passes official arguments through unchanged", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-passthrough-test."));
	const calls: Array<{ method: DirectMethod; args: DirectToolArguments }> = [];
	try {
		await executeDirectTool({
			method: "press_key",
			arguments: { app: "/Applications/Alternate App.app", key: "CMD+A", futureOption: true },
		}, deps(root, async (method, args) => {
			calls.push({ method, args });
			return brokerResult();
		}));
		assert.deepEqual(calls, [{
			method: "press_key",
			args: { app: "/Applications/Alternate App.app", key: "CMD+A", futureOption: true },
		}]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("direct service forwards elicitation handling", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-elicit-test."));
	const onElicitation = async () => ({ action: "accept" as const, content: { choice: "allow" } });
	let observedOptions: Parameters<NonNullable<DirectServiceDependencies["callTool"]>>[2];
	try {
		await executeDirectTool({ method: "list_apps", arguments: {} }, {
			...deps(root, async (_method, _args, options) => {
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

test("mutating methods dispatch without wrapper prompts or contentful audit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-service-full-test."));
	let observed: { method: DirectMethod; args: DirectToolArguments } | undefined;
	try {
		const response = await executeDirectTool(
			{ method: "type_text", arguments: { app: "TextEdit", text: "arbitrary direct action" } },
			deps(root, async (method, args) => {
				observed = { method, args };
				return brokerResult("typed");
			}),
		);
		assert.equal(response.isError, false);
		assert.deepEqual(observed, { method: "type_text", args: { app: "TextEdit", text: "arbitrary direct action" } });
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
			{ method: "get_app_state", arguments: { app: "TextEdit" } },
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
