import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { verifyOfficialBroker } from "../src/runner.ts";

const CLIENT =
	"/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

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

test("official signed broker and typed Computer Use schema are present", async () => {
	assert.match(verifyOfficialBroker(), /^codex-cli\s+\d+\./);
	const proc = spawn(CLIENT, ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
	try {
		const initialized = await rpc(proc, 1, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "pi-background-native-app-test", version: "1" },
		});
		assert.equal(initialized.result.serverInfo.name, "Computer Use");
		proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const listed = await rpc(proc, 2, "tools/list", {});
		assert.deepEqual(
			listed.result.tools.map((tool: any) => tool.name),
			[
				"list_apps",
				"get_app_state",
				"click",
				"perform_secondary_action",
				"set_value",
				"select_text",
				"scroll",
				"drag",
				"press_key",
				"type_text",
			],
		);
	} finally {
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => proc.once("close", () => resolve()));
	}
});
