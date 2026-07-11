import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("approval helper is syntax-valid, symlinks auth, and wraps cleanup", async () => {
	for (const script of ["test-harness/create-approval-home.sh", "test-harness/run-approval-tui.sh"]) {
		execFileSync("/bin/bash", ["-n", path.resolve(script)], { stdio: "ignore", timeout: 5000 });
	}
	const create = await readFile(path.resolve("test-harness/create-approval-home.sh"), "utf8");
	const run = await readFile(path.resolve("test-harness/run-approval-tui.sh"), "utf8");
	assert.match(create, /ln -s \"\$SOURCE_AUTH\"/);
	assert.doesNotMatch(create, /cp \"\$SOURCE_AUTH\"/);
	assert.match(run, /trap cleanup EXIT HUP INT TERM/);
});

test("disposable native harnesses build with distinct identities and no persistence/network code", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cua-harness-build-test."));
	try {
		execFileSync(path.resolve("test-harness/build.sh"), [root], { stdio: "ignore", timeout: 120_000 });
		const apps = [
			["CUA Harness A.app", "dev.codexcomputeruse.cua-harness-a"],
			["CUA Harness B.app", "dev.codexcomputeruse.cua-harness-b"],
		] as const;
		for (const [name, expectedId] of apps) {
			const app = path.join(root, name);
			execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], { stdio: "ignore", timeout: 10_000 });
			const actualId = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(app, "Contents", "Info.plist")], {
				encoding: "utf8",
				timeout: 5000,
			}).trim();
			assert.equal(actualId, expectedId);
		}
		const source = await readFile(path.resolve("test-harness/main.swift"), "utf8");
		assert.doesNotMatch(source, /URLSession|NSWorkspace|FileManager|write\(|removeItem|UserDefaults/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
