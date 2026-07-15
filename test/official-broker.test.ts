import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { COMPUTER_USE_CLIENT_PATH, verifyOfficialDirectBroker } from "../src/direct-broker.ts";
import { EXPECTED_OFFICIAL_INPUT_SCHEMAS, OFFICIAL_METHODS, OFFICIAL_TOOL_METADATA } from "../src/tools.ts";

function rpc(proc: ReturnType<typeof spawn>, id: number, method: string, params: unknown): Promise<any> {
	proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timeout = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5000);
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line);
				if (message.id === id) {
					clearTimeout(timeout);
					proc.stdout!.off("data", onData);
					resolve(message);
					return;
				}
			}
		};
		proc.stdout!.on("data", onData);
	});
}

test("official signed app-server broker and exact ten-tool helper inventory are present", async () => {
	const verified = verifyOfficialDirectBroker();
	assert.match(verified.brokerVersion, /^codex-cli\s+\d+\./);
	assert.match(verified.clientBuild, /^\d+$/);
	const proc = spawn(COMPUTER_USE_CLIENT_PATH, ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
	try {
		const initialized = await rpc(proc, 1, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "direct-computer-use-test", version: "1" },
		});
		assert.equal(initialized.result.serverInfo.name, "Computer Use");
		proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const listed = await rpc(proc, 2, "tools/list", {});
		assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), OFFICIAL_METHODS);
		for (const method of OFFICIAL_METHODS) {
			const tool = listed.result.tools.find((item: any) => item.name === method);
			assert.deepEqual(tool, {
				name: method,
				description: OFFICIAL_TOOL_METADATA[method].description,
				inputSchema: EXPECTED_OFFICIAL_INPUT_SCHEMAS[method],
				annotations: OFFICIAL_TOOL_METADATA[method].annotations,
			});
		}
	} finally {
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => proc.once("close", () => resolve()));
	}
});
