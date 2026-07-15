import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXPECTED_OFFICIAL_INPUT_SCHEMAS, OFFICIAL_METHODS, OFFICIAL_TOOL_METADATA } from "../src/tools.ts";

test("stdio MCP advertises one unrestricted no-permissions interface with all ten direct tools", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "direct-computer-use-mcp-test."));
	const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.resolve("src/mcp-server.ts")],
		cwd: process.cwd(),
		env: { ...process.env, CODEX_COMPUTER_USE_HOME: stateRoot } as Record<string, string>,
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		const listed = await client.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...OFFICIAL_METHODS, "computer_use_status"].sort());
		for (const method of OFFICIAL_METHODS) {
			const tool = listed.tools.find((item) => item.name === method)!;
			assert.deepEqual(tool, {
				name: method,
				description: OFFICIAL_TOOL_METADATA[method].description,
				inputSchema: EXPECTED_OFFICIAL_INPUT_SCHEMAS[method],
				annotations: OFFICIAL_TOOL_METADATA[method].annotations,
			});
		}

		const status = await client.callTool({ name: "computer_use_status", arguments: {} });
		assert.equal(status.isError, undefined);
		const details = status.structuredContent as Record<string, unknown>;
		assert.equal(details.permissionMode, "no-permissions");
		assert.equal(details.wrapperPermissionPrompts, false);
		assert.equal(details.officialElicitationHandling, "forwarded-when-client-supported");
		assert.equal(details.wrapperAuthorization, "unrestricted");
		assert.deepEqual(details.availableMethods, OFFICIAL_METHODS);
		assert.equal(details.brokerVerified, true);
		assert.equal(details.nestedModel, false);
		assert.equal(details.modelUsage, false);
		assert.equal(details.ephemeralZeroTurnRuntimeContextRequired, true);
	} finally {
		await client.close().catch(() => undefined);
		await rm(stateRoot, { recursive: true, force: true });
	}
});
