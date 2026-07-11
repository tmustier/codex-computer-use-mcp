import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAudit } from "../src/audit.ts";

test("audit is mode-0600 structured metadata without task text", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-audit-test."));
	try {
		const auditPath = await appendAudit(root, {
			timestamp: "2026-07-10T00:00:00.000Z",
			runId: "run",
			operation: "calculate",
			permissionMode: "safe",
			app: "Calculator",
			mutating: true,
			cleanupRequested: true,
			userConfirmed: true,
			authorization: "full_permissions_config",
			inputBytes: 3,
			outcome: "ok",
			durationMs: 1,
			model: "gpt-5.6-sol",
			usage: { input: 1, cachedInput: 0, output: 1 },
			computerUseCalls: 3,
			backgroundPreserved: true,
			cleanupVerified: true,
		});
		const mode = (await stat(auditPath)).mode & 0o777;
		assert.equal(mode, 0o600);
		const record = JSON.parse((await readFile(auditPath, "utf8")).trim());
		assert.equal(record.inputBytes, 3);
		assert.equal(record.authorization, "full_permissions_config");
		assert.equal(record.permissionMode, "safe");
		assert.equal(Object.hasOwn(record, "value"), false);
		assert.equal(Object.hasOwn(record, "observed"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("audit refuses symlinked state and log targets", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-audit-symlink-test."));
	const outside = path.join(root, "outside.txt");
	const record = {
		timestamp: "2026-07-10T00:00:00.000Z",
		runId: "run",
		operation: "inspect",
		permissionMode: "safe" as const,
		app: null,
		mutating: false,
		cleanupRequested: true,
		userConfirmed: false,
		authorization: "none" as const,
		inputBytes: 0,
		outcome: "failed",
		durationMs: 1,
		model: "gpt-5.6-sol",
		usage: { input: 0, cachedInput: 0, output: 0 },
		computerUseCalls: 0,
		backgroundPreserved: null,
		cleanupVerified: null,
	};
	try {
		await writeFile(outside, "untouched\n", { mode: 0o600 });
		await symlink(outside, path.join(root, "state-link"));
		await assert.rejects(() => appendAudit(path.join(root, "state-link"), record));
		assert.equal(await readFile(outside, "utf8"), "untouched\n");

		const state = path.join(root, "state");
		const log = await appendAudit(state, { ...record, runId: "seed" });
		await rm(log);
		await symlink(outside, log);
		await assert.rejects(() => appendAudit(state, record));
		assert.equal(await readFile(outside, "utf8"), "untouched\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
