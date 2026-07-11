import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAudit, type AuditRecord } from "../src/audit.ts";

const record: AuditRecord = {
	timestamp: "2026-07-11T00:00:00.000Z",
	runId: "run",
	method: "type_text",
	permissionMode: "full-permissions",
	app: "com.apple.TextEdit",
	mutating: true,
	authorization: "full_permissions_config",
	inputBytes: 19,
	outcome: "ok",
	durationMs: 20,
	brokerVersion: "codex-cli 0.144.0-alpha.4",
	clientBuild: "1000366",
	directCalls: 1,
	modelTurnsStarted: 0,
	ephemeralThread: true,
	approvalRequests: 0,
	backgroundPreserved: true,
	brokerCleanupVerified: true,
	resultContentTypes: ["text"],
	resultBytes: 42,
};

test("audit is mode-0600 metadata without arguments, output, or secrets", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-audit-test."));
	try {
		const auditPath = await appendAudit(root, record);
		assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
		const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim());
		assert.equal(parsed.method, "type_text");
		assert.equal(parsed.modelTurnsStarted, 0);
		assert.equal(parsed.directCalls, 1);
		assert.equal(parsed.inputBytes, 19);
		for (const forbidden of ["arguments", "text", "value", "content", "structuredContent", "token", "prompt", "modelUsage"]) {
			assert.equal(Object.hasOwn(parsed, forbidden), false, forbidden);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("audit refuses symlinked state and log targets", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-audit-symlink-test."));
	const outside = path.join(root, "outside.txt");
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
