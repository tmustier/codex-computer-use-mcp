import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const packReportSchema = z.object({
	filename: z.string(),
	files: z.array(z.object({ path: z.string() })),
});
const packOutputSchema = z.union([
	z.array(packReportSchema).nonempty(),
	z.record(z.string(), packReportSchema),
]);

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
		const parsedReport = packOutputSchema.parse(JSON.parse(stdout));
		const report = Array.isArray(parsedReport) ? parsedReport[0] : Object.values(parsedReport)[0];
		assert.ok(report);
		const files = report.files.map((item) => item.path).sort();
		for (const required of [
			"README.md",
			"SECURITY.md",
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
		assert.equal(JSON.parse(status.stdout).permissionMode, "no-permissions");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
