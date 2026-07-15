import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { forwardOfficialElicitationToMcpClient } from "../src/mcp-elicitation.ts";

test("generic MCP forwards standard official form elicitations and returns the client response", async () => {
	let observedParams: unknown;
	let observedOptions: unknown;
	const controller = new AbortController();
	const response = await forwardOfficialElicitationToMcpClient({
		async elicitInput(params, options) {
			observedParams = params;
			observedOptions = options;
			return { action: "accept", content: { choice: "allow" }, _meta: { client: "test" } };
		},
	}, {
		mode: "form",
		message: "Choose access",
		requestedSchema: {
			type: "object",
			properties: { choice: { type: "string", enum: ["allow", "deny"] } },
			required: ["choice"],
		},
		_meta: { source: "official-test" },
	}, controller.signal);
	assert.deepEqual(observedParams, {
		mode: "form",
		message: "Choose access",
		requestedSchema: {
			type: "object",
			properties: { choice: { type: "string", enum: ["allow", "deny"] } },
			required: ["choice"],
		},
		_meta: { source: "official-test" },
	});
	assert.equal((observedOptions as any).signal, controller.signal);
	assert.deepEqual(response, { action: "accept", content: { choice: "allow" }, _meta: { client: "test" } });
});

test("generic MCP elicitation crosses a real SDK client/server transport", async () => {
	const server = new Server({ name: "test-server", version: "1" }, { capabilities: {} });
	const client = new Client({ name: "test-client", version: "1" }, { capabilities: { elicitation: { form: {} } } });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	let observed: unknown;
	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		observed = request.params;
		return { action: "accept", content: { name: "Thomas" } };
	});
	try {
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const response = await forwardOfficialElicitationToMcpClient(server, {
			mode: "form",
			message: "Your name",
			requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
		});
		assert.deepEqual(observed, {
			mode: "form",
			message: "Your name",
			requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
		});
		assert.deepEqual(response, { action: "accept", content: { name: "Thomas" } });
	} finally {
		await client.close().catch(() => undefined);
		await server.close().catch(() => undefined);
	}
});

test("generic MCP forwards URL elicitations without converting them into wrapper prompts", async () => {
	let observed: unknown;
	const response = await forwardOfficialElicitationToMcpClient({
		async elicitInput(params) {
			observed = params;
			return { action: "decline" };
		},
	}, {
		mode: "url",
		message: "Complete setup",
		elicitationId: "setup-1",
		url: "https://example.test/setup",
	});
	assert.deepEqual(observed, {
		mode: "url",
		message: "Complete setup",
		elicitationId: "setup-1",
		url: "https://example.test/setup",
	});
	assert.deepEqual(response, { action: "decline" });
});

test("unsupported or unavailable MCP elicitation support cancels and never fabricates a decline", async () => {
	const unavailable = await forwardOfficialElicitationToMcpClient({
		async elicitInput() { throw new Error("client does not support elicitation"); },
	}, { mode: "form", message: "Input", requestedSchema: { type: "object", properties: {} } });
	assert.deepEqual(unavailable, { action: "cancel" });

	let called = false;
	const proprietary = await forwardOfficialElicitationToMcpClient({
		async elicitInput() { called = true; return { action: "accept" }; },
	}, { mode: "openai/form", message: "Input", requestedSchema: { type: "object", properties: {} } });
	assert.equal(called, false);
	assert.deepEqual(proprietary, { action: "cancel" });
});
