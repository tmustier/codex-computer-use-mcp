import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function packReport(stdout: string): { filename: string; files: Array<{ path: string }> } {
	const parsed = JSON.parse(stdout);
	const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	assert.ok(report && typeof report === "object");
	return report as { filename: string; files: Array<{ path: string }> };
}

test("packed package installs and starts from a plain npm consumer", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "computer-use-package-test."));
	try {
		const projectRoot = process.cwd();
		const sourceRoot = path.join(root, "source");
		await cp(projectRoot, sourceRoot, {
			recursive: true,
			filter: (entry) => ![".git", "dist", "node_modules"].includes(path.relative(projectRoot, entry).split(path.sep)[0]),
		});
		await symlink(path.join(projectRoot, "node_modules"), path.join(sourceRoot, "node_modules"), "dir");
		const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", root], { cwd: sourceRoot });
		const report = packReport(stdout);
		const files = report.files.map((item) => item.path).sort();
		for (const required of [
			"ARCHITECTURE.md",
			"README.md",
			"dist/mcp-server.js",
			"dist/version.js",
			"integrations/pi/index.ts",
			"package.json",
		]) assert.ok(files.includes(required), required);
		for (const excluded of ["package-lock.json", "src/version.ts", "test/package.test.ts", "tsconfig.json"]) {
			assert.equal(files.includes(excluded), false, excluded);
		}

		const consumer = path.join(root, "consumer");
		await mkdir(consumer);
		await writeFile(path.join(consumer, "package.json"), '{"private":true}\n');
		await execFileAsync("npm", ["install", "--no-audit", "--no-fund", path.join(root, report.filename)], { cwd: consumer });

		const installedRoot = path.join(consumer, "node_modules", "codex-computer-use-mcp");
		const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
		assert.equal(installedPackage.scripts.prepare, undefined);
		assert.deepEqual(Object.keys(installedPackage.dependencies).sort(), ["@modelcontextprotocol/sdk", "zod"]);
		await assert.rejects(access(path.join(consumer, "node_modules", "typescript")));
		await assert.rejects(access(path.join(consumer, "node_modules", "@types", "node")));

		const status = await execFileAsync(process.execPath, [path.join(installedRoot, "dist", "mcp-server.js"), "--status"]);
		assert.equal(JSON.parse(status.stdout).architecture, "official-codex-app-server-direct-mcp-tool-call");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
