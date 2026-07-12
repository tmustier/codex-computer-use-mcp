import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const serverPath = path.resolve("src/mcp-server.ts");

function run(stateRoot: string, args: string[]) {
	return execFileAsync(process.execPath, [serverPath, ...args], {
		cwd: process.cwd(),
		env: { ...process.env, CODEX_COMPUTER_USE_HOME: stateRoot },
	});
}

test("CLI requires explicit full-permissions acknowledgement and securely audits mode changes", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "direct-computer-use-cli-test."));
	try {
		await assert.rejects(run(stateRoot, ["--configure", "full-permissions"]), /acknowledge-full-permissions/);
		await run(stateRoot, ["--configure", "full-permissions", "--acknowledge-full-permissions"]);
		const configPath = path.join(stateRoot, "config.json");
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { version: 1, permissionMode: "full-permissions" });
		assert.equal((await stat(configPath)).mode & 0o777, 0o600);
		const { stdout } = await run(stateRoot, ["--status"]);
		const status = JSON.parse(stdout);
		assert.equal(status.permissionMode, "full-permissions");
		assert.equal(status.nestedModel, false);
		assert.equal(status.modelUsage, false);
		assert.equal(status.ephemeralZeroTurnRuntimeContextRequired, true);

		await run(stateRoot, ["--configure", "safe"]);
		const records = (await readFile(path.join(stateRoot, "audit", "direct-computer-use.jsonl"), "utf8"))
			.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.map((item) => item.permissionMode), ["full-permissions", "safe"]);
		assert.ok(records.every((item) => item.modelTurnsStarted === 0 && item.directCalls === 0));
		assert.ok(records.every((item) => !JSON.stringify(item).includes("acknowledge-full-permissions")));
	} finally {
		await rm(stateRoot, { recursive: true, force: true });
	}
});
