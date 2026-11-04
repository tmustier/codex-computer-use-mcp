import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const broker = await import("../src/direct-broker.ts");
const service = await import("../src/direct-service.ts");

test("the app-server receives ChatGPT's cua_repl entry unchanged, with the real home and a private cwd", async (t) => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cu-nested-codex.")));
	const previous = process.env.CODEX_CLI_PATH;
	try {
		const codex = path.join(root, 'Official Codex "binary"');
		const alias = path.join(root, "configured-codex");
		const nodeRepl = path.join(root, "cua_node/bin/node_repl");
		const computerUseApp = path.join(root, "Codex Computer Use.app");
		const serviceBinary = path.join(computerUseApp, "Contents/MacOS/SkyComputerUseService");
		for (const file of [codex, nodeRepl, serviceBinary]) {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, "signed fixture\n");
		}
		await symlink(codex, alias);
		const server = {
			command: "/bin/sh",
			args: ["-c", 'export X="${X-}"; exec "$@"', "cua-repl", nodeRepl],
			env: { SKY_CUA_SERVICE_PATH: computerUseApp, NODE_REPL_TOOL_OVERRIDES: '{"a":"b\\nc"}' },
			enabled_tools: ["js", "js_reset", "turn_ended"],
			tools: { js: { output_token_limit: 25000 } },
		};
		const cuaReplConfigPath = path.join(root, "cua.mcp.json");
		await writeFile(cuaReplConfigPath, JSON.stringify({ mcpServers: { cua_repl: server } }));
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ codexPath: alias, cuaReplConfigPath }));
		process.env.CODEX_CLI_PATH = "/ambient/unverified/codex";

		t.mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
			if (command === "/usr/bin/codesign") {
				return args[0] === "--verify" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: "", stderr: "TeamIdentifier=2DC432GLL2\n" };
			}
			if (command === codex && args[0] === "--version") return { status: 0, stdout: "codex-cli 1.0.0\n", stderr: "" };
			if (command === "/usr/bin/plutil") return { status: 0, stdout: "fixture-build\n", stderr: "" };
			throw new Error(`Unexpected verification command: ${command}`);
		});
		const spawn = t.mock.method(childProcess, "spawn", (command: string, args: string[], { cwd, env }: SpawnOptions) => {
			assert.equal(command, codex);
			assert.ok(env);
			assert.equal(env.CODEX_CLI_PATH, undefined);
			assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
			assert.notEqual(env.HOME, os.userInfo().homedir);
			const table = args.find((arg) => arg.startsWith("mcp_servers="));
			assert.equal(table, `mcp_servers=${broker.toToml({
				cua_repl: { ...server, env: { ...server.env, HOME: os.userInfo().homedir }, cwd: String(cwd), enabled: true },
			})}`);
			throw new Error("captured app-server spawn");
		});
		syncBuiltinESMExports();

		await assert.rejects(broker.createOfficialCuaReplSession({ configPath }), /captured app-server spawn/);
		assert.equal(spawn.mock.callCount(), 1);

		const status = service.getDirectStatus(root);
		assert.ok(status.brokerVerified);
		assert.equal(status.codexPath, codex);
		assert.equal(status.nodeReplPath, nodeRepl);
		assert.equal(status.cuaReplConfigPath, cuaReplConfigPath);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env.CODEX_CLI_PATH;
		else process.env.CODEX_CLI_PATH = previous;
		await rm(root, { recursive: true, force: true });
	}
});
