import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("package contains direct architecture, Pi adapter, docs, and shrinkwrap without nested runner artifacts", async () => {
	const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: process.cwd() });
	const report = JSON.parse(stdout)[0];
	const files = report.files.map((item: { path: string }) => item.path).sort();
	for (const required of [
		"ARCHITECTURE.md",
		"MIGRATION.md",
		"README.md",
		"SECURITY.md",
		"PROOF.md",
		"docs/excel-live-control.md",
		"docs/excel-live-probe.json",
		"docs/excel-live-tool-schemas.json",
		"npm-shrinkwrap.json",
		"dist/direct-broker.js",
		"dist/direct-service.js",
		"dist/tools.js",
		"integrations/pi/index.ts",
	]) assert.ok(files.includes(required), required);
	for (const forbidden of ["dist/runner.js", "dist/prompt.js", "dist/service.js", "dist/policy.js", "test-harness/main.swift"]) {
		assert.equal(files.includes(forbidden), false, forbidden);
	}
	assert.equal(report.entryCount, files.length);
});
