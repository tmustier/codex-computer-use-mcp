import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
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

test("CLI exposes durable no-permissions status and no mode-selection route", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "direct-computer-use-cli-test."));
	try {
		const { stdout } = await run(stateRoot, ["--status"]);
		const status = JSON.parse(stdout);
		assert.equal(status.permissionMode, "no-permissions");
		assert.equal(status.approvalPrompts, false);
		assert.equal(status.wrapperAuthorization, "unrestricted");
		assert.equal(status.availableMethods.length, 10);
		assert.equal(status.nestedModel, false);
		assert.equal(status.modelUsage, false);
		assert.equal(status.ephemeralZeroTurnRuntimeContextRequired, true);

		for (const args of [["--configure", "safe"], ["--configure", "full-permissions"], ["--configure", "no-permissions"]]) {
			await assert.rejects(run(stateRoot, args), /has no alternate mode or configuration command/);
		}
		await assert.rejects(access(path.join(stateRoot, "config.json")));
		await assert.rejects(access(path.join(stateRoot, "audit", "direct-computer-use.jsonl")));
	} finally {
		await rm(stateRoot, { recursive: true, force: true });
	}
});
