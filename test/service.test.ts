import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PolicyError } from "../src/policy.ts";
import { executeOperation } from "../src/service.ts";

test("policy-rejected requests are audited without retaining raw app or task content", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "computer-use-service-reject-test."));
  const raw = { mode: "list", app: "Private Untrusted Selector", task: "private task body" };
  try {
    await assert.rejects(() => executeOperation(raw, { stateRoot }), PolicyError);
    const records = (await readFile(path.join(stateRoot, "audit", "background-computer-use.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "policy_rejected");
    assert.match(records[0].app, /^target-sha256:/);
    assert.equal(records[0].inputBytes, Buffer.byteLength(raw.task));
    const serialized = JSON.stringify(records[0]);
    assert.equal(serialized.includes(raw.app), false);
    assert.equal(serialized.includes(raw.task), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("unknown operation names are reduced to invalid_request in audits", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "computer-use-service-invalid-mode-test."));
  const secretMode = "private-mode-value";
  try {
    await assert.rejects(() => executeOperation({ mode: secretMode }, { stateRoot }), PolicyError);
    const record = JSON.parse((await readFile(path.join(stateRoot, "audit", "background-computer-use.jsonl"), "utf8")).trim());
    assert.equal(record.operation, "invalid_request");
    assert.equal(JSON.stringify(record).includes(secretMode), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("cancellation returns structured partial methods and persists them in the audit", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "computer-use-service-cancel-test."));
  try {
    const response = await executeOperation(
      { mode: "list" },
      {
        stateRoot,
        runCodex: async () => ({
          exitCode: 130,
          usage: { input: 10, cachedInput: 4, output: 2 },
          computerUseMethods: ["list_apps"],
          approvalRequiredObserved: false,
          errorKind: "cancelled",
          errorSummary: "Computer Use request cancelled",
          codexVersion: "test-codex",
          durationMs: 12,
        }),
      },
    );
    assert.equal(response.isError, true);
    assert.equal(response.details.outcome, "cancelled");
    assert.equal(response.details.retryAllowed, false);
    assert.deepEqual(response.details.usedCapabilities, ["list_apps"]);
    const record = JSON.parse((await readFile(path.join(stateRoot, "audit", "background-computer-use.jsonl"), "utf8")).trim());
    assert.equal(record.outcome, "cancelled");
    assert.equal(record.computerUseCalls, 1);
    assert.deepEqual(record.computerUseMethods, ["list_apps"]);
    assert.equal(record.cleanupVerified, false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
