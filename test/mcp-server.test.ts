import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP server advertises the public tools and safe default status", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-computer-use-mcp-test."));
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
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["background_computer_use", "background_computer_use_status"],
    );
    const operation = listed.tools.find((tool) => tool.name === "background_computer_use");
    assert.equal(operation?.annotations?.destructiveHint, true);
    assert.deepEqual(operation?.inputSchema.required, ["mode"]);

    const status = await client.callTool({ name: "background_computer_use_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as Record<string, unknown>).permissionMode, "safe");
    assert.equal((status.structuredContent as Record<string, unknown>).officialApprovalAuthoritative, true);
    assert.equal((status.structuredContent as Record<string, unknown>).brokerVerified, true);
    assert.match(String((status.structuredContent as Record<string, unknown>).brokerVersion), /^codex-cli /);

    const unconfirmed = await client.callTool({
      name: "background_computer_use",
      arguments: { mode: "inspect", app: "TextEdit" },
    });
    assert.equal(unconfirmed.isError, true);
    assert.match(String(unconfirmed.content[0] && "text" in unconfirmed.content[0] ? unconfirmed.content[0].text : ""), /safe mode permits only list/i);
  } finally {
    await client.close().catch(() => {});
    await rm(stateRoot, { recursive: true, force: true });
  }
});
