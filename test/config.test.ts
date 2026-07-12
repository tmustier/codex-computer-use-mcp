import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, configPath, loadConfig, saveConfig } from "../src/config.ts";

test("missing config migrates safely and explicit full-permissions persists mode-0600", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bcu-config-test."));
	try {
		assert.deepEqual(await loadConfig(root), { version: 1, permissionMode: "safe" });
		const file = await saveConfig(root, { version: 1, permissionMode: "full-permissions" });
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.deepEqual(await loadConfig(root), { version: 1, permissionMode: "full-permissions" });
		assert.match(await readFile(file, "utf8"), /"full-permissions"/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("config rejects unknown values, permissive files, and symlinks", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bcu-config-invalid-test."));
	const outside = path.join(root, "outside.json");
	try {
		await writeFile(configPath(root), '{"version":1,"permissionMode":"everything"}\n', { mode: 0o600 });
		await assert.rejects(() => loadConfig(root), ConfigError);
		await writeFile(configPath(root), '{"version":1,"permissionMode":"safe"}\n');
		await chmod(configPath(root), 0o644);
		await assert.rejects(() => loadConfig(root), ConfigError);
		await chmod(configPath(root), 0o666);
		await assert.rejects(() => loadConfig(root), ConfigError);
		await rm(configPath(root));
		await writeFile(outside, '{"version":1,"permissionMode":"full-permissions"}\n', { mode: 0o600 });
		await symlink(outside, configPath(root));
		await assert.rejects(() => loadConfig(root), ConfigError);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("config requires an existing state directory to have exact mode 0700", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bcu-config-state-mode-test."));
	try {
		await chmod(root, 0o755);
		await assert.rejects(() => loadConfig(root), /mode 0700/);
		await assert.rejects(() => saveConfig(root, { version: 1, permissionMode: "safe" }), /mode 0700/);
	} finally {
		await chmod(root, 0o700);
		await rm(root, { recursive: true, force: true });
	}
});

test("config refuses a symlinked state directory", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bcu-config-state-symlink-test."));
	const realState = path.join(root, "real-state");
	const linkedState = path.join(root, "linked-state");
	try {
		await mkdir(realState, { mode: 0o700 });
		await symlink(realState, linkedState);
		await assert.rejects(() => loadConfig(linkedState), ConfigError);
		await assert.rejects(() => saveConfig(linkedState, { version: 1, permissionMode: "full-permissions" }), ConfigError);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
