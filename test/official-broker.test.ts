import assert from "node:assert/strict";
import os from "node:os";
import nodeTest from "node:test";

// macOS ChatGPT layout and live macOS Computer Use; Windows has its own tests.
const test = process.platform === "darwin" ? nodeTest : nodeTest.skip;
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callOfficialCuaRepl, readOfficialCuaReplServer } from "../src/direct-broker.ts";
import { cuaReplToolDefinitions } from "../src/tools.ts";

test("official signed broker completes a real cua_repl call", async () => {
	const result = await callOfficialCuaRepl("js", {
		code: 'let app = await cua.getApp("Finder", { emit: false }); nodeRepl.write("ready:" + typeof app.getAXState);',
	});
	assert.equal(result.isError, false);
	assert.equal(result.brokerCleanupVerified, true);
	assert.equal(result.modelTurnsStarted, 0);
	assert.equal(result.ephemeralThread, true);
	assert.ok(result.content.some((block) => block.type === "text" && String(block.text).includes("ready:function")));
});

test("the advertised tool definitions match official node_repl's own", async () => {
	const server = readOfficialCuaReplServer();
	const client = new Client({ name: "definition-check", version: "1.0.0" });
	// Listing tools needs no Computer Use service, so node_repl can run without its signed parent here.
	await client.connect(new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: { ...server.env, HOME: os.userInfo().homedir, PATH: "/usr/bin:/bin" },
		stderr: "ignore",
	}));
	try {
		const listed = (await client.listTools()).tools;
		const ours = cuaReplToolDefinitions(server.env);
		assert.equal(client.getInstructions(), ours.instructions);
		for (const definition of ours.tools) {
			const official = listed.find((tool) => tool.name === definition.name);
			assert.ok(official, definition.name);
			const { oneOf: _oneOf, ...inputSchema } = official.inputSchema;
			assert.deepEqual({ ...official, inputSchema }, definition);
		}
	} finally {
		await client.close();
	}
});
