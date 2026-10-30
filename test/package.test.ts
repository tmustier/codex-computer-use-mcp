import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { z } from "zod";

const execFileAsync = promisify(execFile);
// npm is a .cmd shim on Windows, which Node only runs through a shell.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmOptions = (cwd: string) => ({ cwd, shell: process.platform === "win32" });
const packReportSchema = z.object({
	filename: z.string(),
	files: z.array(z.object({ path: z.string() })),
});
const packOutputSchema = z.union([
	z.array(packReportSchema).nonempty(),
	z.record(z.string(), packReportSchema),
]);

test("registry and git packages install and start from a plain npm consumer", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "computer-use-package-test."));
	try {
		const projectRoot = process.cwd();
		const sourceRoot = path.join(root, "source");
		await cp(projectRoot, sourceRoot, {
			recursive: true,
			filter: (entry) => ![".git", "dist", "node_modules"].includes(path.relative(projectRoot, entry).split(path.sep)[0]),
		});
		// A junction needs no symlink privilege on Windows.
		await symlink(path.join(projectRoot, "node_modules"), path.join(sourceRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const { stdout } = await execFileAsync(npm, ["pack", "--json", "--pack-destination", root], npmOptions(sourceRoot));
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

		await execFileAsync("git", ["init", sourceRoot]);
		await execFileAsync("git", ["add", "package.json", "package-lock.json", "tsconfig.json", "src", "integrations", "README.md", "SECURITY.md", "LICENSE"], { cwd: sourceRoot });
		await execFileAsync("git", ["-c", "user.name=Package test", "-c", "user.email=test@example.invalid", "commit", "-m", "Package fixture"], { cwd: sourceRoot });

		for (const [name, source] of [
			["registry", path.join(root, report.filename)],
			// A file URL, so a Windows drive path is not read as a URL scheme.
			["git", `git+${pathToFileURL(sourceRoot).href}`],
		]) {
			const consumer = path.join(root, name);
			await mkdir(consumer);
			await writeFile(path.join(consumer, "package.json"), '{"private":true}\n');
			await execFileAsync(npm, ["install", "--no-audit", "--no-fund", "--allow-git=all", source], npmOptions(consumer));

			const installedRoot = path.join(consumer, "node_modules", "codex-computer-use-mcp");
			await assert.rejects(access(path.join(consumer, "node_modules", "typescript")));
			await assert.rejects(access(path.join(consumer, "node_modules", "@types", "node")));

			const status = await execFileAsync(process.execPath, [path.join(installedRoot, "dist", "mcp-server.js"), "--status"]);
			assert.equal(JSON.parse(status.stdout).permissionMode, "no-permissions");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
