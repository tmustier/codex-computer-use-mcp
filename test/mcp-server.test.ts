import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_INPUT_SCHEMAS, COMPUTER_USE_METHODS, TOOL_METADATA } from "../src/tools.ts";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

test("stdio MCP exposes all tools and retains a live session across multiple actions", async () => {
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
		assert.deepEqual(client.getServerVersion(), { name: "codex-computer-use-mcp", version: packageVersion });
		const listed = await client.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...COMPUTER_USE_METHODS, "computer_use_status"].sort());
		for (const method of COMPUTER_USE_METHODS) {
			const tool = listed.tools.find((item) => item.name === method)!;
			assert.deepEqual(tool, {
				name: method,
				description: TOOL_METADATA[method].description,
				inputSchema: TOOL_INPUT_SCHEMAS[method],
				annotations: TOOL_METADATA[method].annotations,
			});
		}

		const status = await client.callTool({ name: "computer_use_status", arguments: {} });
		assert.equal(status.isError, undefined);
		const details = status.structuredContent as Record<string, unknown>;
		assert.equal(details.permissionMode, "no-permissions");
		assert.equal(details.wrapperPermissionPrompts, false);
		assert.equal(details.officialApprovalPolicy, "full-access");
		assert.equal(details.officialAppApprovalHandling, "auto-approved-by-codex-full-access");
		assert.equal(details.officialElicitationHandling, "forwarded-if-emitted");
		assert.equal(details.wrapperAuthorization, "unrestricted");
		assert.deepEqual(details.availableMethods, COMPUTER_USE_METHODS);
		assert.equal(details.brokerVerified, true);
		assert.equal(details.nestedModel, false);
		assert.equal(details.modelUsage, false);
		assert.equal(details.ephemeralZeroTurnRuntimeContextRequired, true);

		const state = await client.callTool({ name: "get_app_state", arguments: { app: "com.apple.finder" } });
		const firstAction = await client.callTool({ name: "press_key", arguments: { app: "com.apple.finder", key: "Escape" } });
		const secondAction = await client.callTool({ name: "press_key", arguments: { app: "com.apple.finder", key: "Escape" } });
		for (const result of [state, firstAction, secondAction]) {
			assert.notEqual(result.isError, true);
			assert.equal((result.structuredContent as Record<string, unknown>).brokerCleanupVerified, false);
		}
		const audits = (await readFile(path.join(stateRoot, "audit", "direct-computer-use.jsonl"), "utf8"))
			.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(audits.slice(-3).map((record) => record.method), ["get_app_state", "press_key", "press_key"]);
		assert.ok(audits.slice(-3).every((record) => record.brokerCleanupVerified === false));
	} finally {
		await client.close().catch(() => undefined);
		await rm(stateRoot, { recursive: true, force: true });
	}
});
