import assert from "node:assert/strict";
import test from "node:test";
import { unexpectedLsofStderr } from "../src/lsof-stderr.ts";

const snapshot = "/Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/MacBook Pro/2026-10-29-211932/Macintosh HD - Data";
const device = 0x1000010;
const warning = (mount = snapshot, mountDevice = "3200006e") =>
	`lsof: WARNING: can't stat() apfs file system ${mount}\n`
	+ "      Output information may be incomplete.\n"
	+ `      assuming "dev=${mountDevice}" from mount table\n`;

test("ignores only the known snapshot warning on another device", () => {
	assert.equal(unexpectedLsofStderr(warning(), "/private/tmp/work", device), "");
	assert.equal(unexpectedLsofStderr(warning() + warning(), "/private/tmp/work", device), "");
	assert.equal(unexpectedLsofStderr("\n", "/private/tmp/work", device), "");
});

test("preserves warnings about the working directory's device or mount", () => {
	assert.notEqual(unexpectedLsofStderr(warning(snapshot, device.toString(16)), "/private/tmp/work", device), "");
	assert.notEqual(unexpectedLsofStderr(warning(), snapshot, device), "");
	assert.notEqual(unexpectedLsofStderr(warning(), `${snapshot}/work`, device), "");
});

test("preserves unrelated, incomplete and additional diagnostics", () => {
	for (const stderr of [
		"lsof: permission denied\n",
		warning("/Volumes/other"),
		warning().replace("apfs", "nfs"),
		warning().replace('      assuming "dev=3200006e" from mount table\n', ""),
		warning().replace("3200006e", "unknown"),
	]) {
		assert.equal(unexpectedLsofStderr(stderr, "/private/tmp/work", device), stderr.trim());
	}
	assert.equal(unexpectedLsofStderr(warning() + "lsof: other error\n", "/private/tmp/work", device), "lsof: other error");
});
