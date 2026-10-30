import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const broker = await import("../src/direct-broker.ts");
const service = await import("../src/direct-service.ts");
const macTest = process.platform === "darwin" ? test : test.skip;

macTest("the nested Computer Use server receives only the verified Codex path", async (t) => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cu-nested-codex.")));
	const previous = process.env.CODEX_CLI_PATH;
	try {
		const codex = path.join(root, 'Official Codex "binary"');
		const alias = path.join(root, "configured-codex");
		const app = path.join(root, "Codex Computer Use.app");
		const client = path.join(app, "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient");
		await mkdir(path.dirname(client), { recursive: true });
		await writeFile(client, "signed fixture\n");
		await writeFile(codex, "signed fixture\n");
		await symlink(codex, alias);
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ codexPath: alias, computerUseAppPath: app }));
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
			const table = args.find((arg) => arg.startsWith("mcp_servers="));
			assert.ok(table);
			assert.ok(table.includes(`command = ${JSON.stringify(client)}`));
			assert.ok(table.includes(`cwd = ${JSON.stringify(cwd)}`));
			const nativeEnv = /, env = \{ CODEX_CLI_PATH = ("(?:[^"\\]|\\.)*") \}/.exec(table);
			assert.ok(nativeEnv);
			assert.equal(JSON.parse(nativeEnv[1]!), codex);
			throw new Error("captured app-server spawn");
		});
		syncBuiltinESMExports();

		await assert.rejects(broker.createOfficialDirectToolSession({ configPath }), /captured app-server spawn/);
		assert.equal(spawn.mock.callCount(), 1);

		const status = service.getDirectStatus(root);
		assert.ok(status.brokerVerified);
		assert.equal(status.codexPath, codex);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env.CODEX_CLI_PATH;
		else process.env.CODEX_CLI_PATH = previous;
		await rm(root, { recursive: true, force: true });
	}
});
