import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { selectComputerUseRoute } from "../src/direct-service.ts";
import packageMetadata from "../package.json" with { type: "json" };

const packageVersion = packageMetadata.version;

function stringEnvironment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

test("stdio MCP exposes the official cua_repl tools and status", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "direct-computer-use-mcp-test."));
	const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.resolve("src/mcp-server.ts")],
		cwd: process.cwd(),
		env: { ...stringEnvironment(), CODEX_COMPUTER_USE_HOME: stateRoot },
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		assert.deepEqual(client.getServerVersion(), { name: "codex-computer-use-mcp", version: packageVersion });
		const route = await selectComputerUseRoute(stateRoot);
		assert.equal(route.kind, "cua_repl");
		const official = route.official;
		assert.equal(client.getInstructions(), official.instructions);
		const listed = await client.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name), ["js", "js_reset", "computer_use_status"]);
		assert.deepEqual(listed.tools.slice(0, 2), official.tools);

		const statusResult = await client.callTool({ name: "computer_use_status", arguments: {} });
		assert.equal(statusResult.isError, undefined);
		const status = z.object({
			permissionMode: z.literal("no-permissions"),
			tools: z.array(z.string()),
			brokerVerified: z.boolean(),
		}).passthrough().parse(statusResult.structuredContent);
		assert.deepEqual(status.tools, ["js", "js_reset"]);
		assert.equal(status.route, "cua_repl");
		assert.equal(status.brokerVerified, true);
	} finally {
		await client.close().catch(() => undefined);
		await rm(stateRoot, { recursive: true, force: true });
	}
});
