import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import adapter from "../../integrations/pi/index.ts";
import { computerUseToolName } from "../../integrations/pi/legacy.ts";
import { selectComputerUseRoute } from "../../src/direct-service.ts";
import { hostPlatform } from "../../src/legacy/platform.ts";

const platform = hostPlatform();
const macTest = process.platform === "darwin" ? test : test.skip;

/** A state directory whose config names a ChatGPT for which ChatGPT has written no cua_repl settings. */
async function stateWithoutUnifiedRuntime(root: string): Promise<string> {
	const app = path.join(root, "ChatGPT.app");
	await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
	await writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.1-no-unified-runtime</string></dict></plist>`);
	await writeFile(path.join(app, "Contents", "Resources", "codex"), "", { mode: 0o755 });
	const stateRoot = path.join(root, "state");
	await mkdir(stateRoot);
	await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({ codexPath: path.join(app, "Contents", "Resources", "codex") }));
	return stateRoot;
}

macTest("a ChatGPT without its unified runtime selects the deprecated typed tools", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cu-route-legacy.")));
	try {
		const route = selectComputerUseRoute(await stateWithoutUnifiedRuntime(root));
		assert.equal(route.kind, "legacy");
		assert.match(route.kind === "legacy" ? route.reason : "", /ChatGPT 0\.0\.1-no-unified-runtime has not prepared its Computer Use runtime/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

macTest("a configured cua_repl settings path that is missing does not fall back", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cu-route-configured.")));
	try {
		await writeFile(path.join(root, "config.json"), JSON.stringify({ cuaReplConfigPath: path.join(root, "missing.mcp.json") }));
		const route = selectComputerUseRoute(root);
		assert.equal(route.kind, "cua_repl");
		assert.match(route.kind === "cua_repl" ? route.official.tools[0]!.description : "", /Computer Use is not ready: .*missing\.mcp\.json/s);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi registers the host platform codemode tools when the unified runtime is missing", () => {
	const tools: Array<{ name: string; exposure?: string }> = [];
	const fakePi = {
		registerTool(tool: { name: string; exposure?: string }) { tools.push(tool); },
		registerCommand() {},
		on() {},
	};
	// SAFETY: this focused adapter test implements every ExtensionAPI member registration uses.
	adapter(fakePi as any, { route: { kind: "legacy", reason: "test" } });
	assert.deepEqual(tools.map((tool) => tool.name), platform.methods.map(computerUseToolName));
	assert.ok(tools.every((tool) => tool.exposure === "codemode"));
});

test("stdio MCP serves the host platform typed tools and says the route is deprecated", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cu-route-mcp.")));
	const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
	try {
		const stateRoot = await stateWithoutUnifiedRuntime(root);
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
		await client.connect(new StdioClientTransport({
			command: process.execPath,
			args: [path.resolve("src/mcp-server.ts")],
			env: { ...env, CODEX_COMPUTER_USE_HOME: stateRoot },
			stderr: "pipe",
		}));
		const listed = await client.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name), [...platform.methods, "computer_use_status"]);
		const status = z.object({ route: z.string(), deprecated: z.string(), platform: z.string() }).passthrough()
			.parse((await client.callTool({ name: "computer_use_status", arguments: {} })).structuredContent);
		assert.equal(status.route, "legacy");
		assert.equal(status.platform, platform.name);
		assert.match(status.deprecated, /older typed Computer Use tools/);
	} finally {
		await client.close().catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});
