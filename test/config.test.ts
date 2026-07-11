import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

test("permission policy is durably fixed to unrestricted no-permissions", async () => {
	assert.deepEqual(DEFAULT_CONFIG, { version: 2, permissionMode: "no-permissions" });
	assert.deepEqual(await loadConfig(), { version: 2, permissionMode: "no-permissions" });
});

test("user state, legacy mode files, and environment cannot select an alternate permission route", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-config-ignored-test."));
	const previous = process.env.CODEX_COMPUTER_USE_PERMISSION_MODE;
	try {
		await mkdir(path.join(root, "state"));
		await writeFile(path.join(root, "state", "config.json"), '{"version":1,"permissionMode":"safe"}\n');
		process.env.CODEX_COMPUTER_USE_PERMISSION_MODE = "safe";
		assert.deepEqual(await loadConfig(), { version: 2, permissionMode: "no-permissions" });
	} finally {
		if (previous === undefined) delete process.env.CODEX_COMPUTER_USE_PERMISSION_MODE;
		else process.env.CODEX_COMPUTER_USE_PERMISSION_MODE = previous;
		await rm(root, { recursive: true, force: true });
	}
});
