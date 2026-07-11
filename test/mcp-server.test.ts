import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OFFICIAL_METHODS } from "../src/tools.ts";

test("stdio MCP server advertises ten direct tools, status, and pre-dispatch safe mutation rejection", async () => {
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
			assert.match(tool.description ?? "", /no nested model/i);
			assert.equal(tool.annotations?.readOnlyHint, method === "list_apps" || method === "get_app_state");
		}

		const status = await client.callTool({ name: "computer_use_status", arguments: {} });
		assert.equal(status.isError, undefined);
		const details = status.structuredContent as Record<string, unknown>;
		assert.equal(details.permissionMode, "safe");
		assert.equal(details.brokerVerified, true);
		assert.equal(details.nestedModel, false);
		assert.equal(details.modelUsage, false);
		assert.equal(details.ephemeralZeroTurnRuntimeContextRequired, true);

		const rejected = await client.callTool({ name: "click", arguments: { app: "TextEdit", element_index: "button-1" } });
		assert.equal(rejected.isError, true);
		assert.match(String(rejected.content[0] && "text" in rejected.content[0] ? rejected.content[0].text : ""), /full-permissions/);
		const audit = JSON.parse((await readFile(path.join(stateRoot, "audit", "direct-computer-use.jsonl"), "utf8")).trim());
		assert.equal(audit.outcome, "policy_rejected");
		assert.equal(audit.directCalls, 0);
		assert.equal(audit.modelTurnsStarted, 0);
	} finally {
		await client.close().catch(() => undefined);
		await rm(stateRoot, { recursive: true, force: true });
	}
});
