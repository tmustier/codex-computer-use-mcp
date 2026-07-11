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
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-computer-use-cli-test."));
  try {
    await assert.rejects(run(stateRoot, ["--configure", "full-permissions"]), /acknowledge-full-permissions/);

    await run(stateRoot, ["--configure", "full-permissions", "--acknowledge-full-permissions"]);
    const configPath = path.join(stateRoot, "config.json");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { version: 1, permissionMode: "full-permissions" });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const { stdout } = await run(stateRoot, ["--status"]);
    assert.equal(JSON.parse(stdout).permissionMode, "full-permissions");

    await run(stateRoot, ["--configure", "safe"]);
    const records = (await readFile(path.join(stateRoot, "audit", "background-computer-use.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.permissionMode), ["full-permissions", "safe"]);
    assert.ok(records.every((record) => !JSON.stringify(record).includes("acknowledge-full-permissions")));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
