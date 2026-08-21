import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { forwardOfficialElicitationToMcpClient } from "../src/mcp-elicitation.ts";

test("generic MCP form elicitation crosses the SDK transport unchanged", async () => {
	const server = new Server({ name: "test-server", version: "1" }, { capabilities: {} });
	const client = new Client({ name: "test-client", version: "1" }, { capabilities: { elicitation: { form: {} } } });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const controller = new AbortController();
	let observed: unknown;
	let observedSignal: AbortSignal | undefined;
	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		observed = request.params;
		return { action: "accept", content: { name: "Thomas" }, _meta: { client: "test" } };
	});
	try {
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const response = await forwardOfficialElicitationToMcpClient({
			async elicitInput(params, options) {
				observedSignal = options?.signal;
				return server.elicitInput(params, options);
			},
		}, {
			mode: "form",
			message: "Your name",
			requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			_meta: { source: "official-test" },
		}, controller.signal);
		assert.deepEqual(observed, {
			mode: "form",
			message: "Your name",
			requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			_meta: { source: "official-test" },
		});
		assert.equal(observedSignal, controller.signal);
		assert.deepEqual(response, { action: "accept", content: { name: "Thomas" }, _meta: { client: "test" } });
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

test("unavailable MCP elicitation support cancels rather than declining", async () => {
	const response = await forwardOfficialElicitationToMcpClient({
		async elicitInput() { throw new Error("client does not support elicitation"); },
	}, { mode: "form", message: "Input", requestedSchema: { type: "object", properties: {} } });
	assert.deepEqual(response, { action: "cancel" });
});
