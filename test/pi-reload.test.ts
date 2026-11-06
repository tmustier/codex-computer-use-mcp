import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Pi reloads TypeScript on /reload but keeps natively imported JavaScript cached,
// so the Pi entry must reach updated package code after an update and a reload.
test("after a package update, Pi reload runs the updated adapter code", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "computer-use-pi-reload."));
	const projectRoot = process.cwd();
	const installed = path.join(root, "node_modules", "codex-computer-use-mcp");
	const pi = spawn(path.join(projectRoot, "node_modules", ".bin", "pi"), ["--mode", "rpc", "--no-session"], {
		cwd: root,
		shell: process.platform === "win32",
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), CODEX_COMPUTER_USE_HOME: path.join(root, "state") },
	});
	try {
		for (const entry of ["package.json", "src", "dist", "integrations"]) await cp(path.join(projectRoot, entry), path.join(installed, entry), { recursive: true });
		await symlink(path.join(projectRoot, "node_modules"), path.join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		await mkdir(path.join(root, "agent", "extensions"), { recursive: true });
		await writeFile(path.join(root, "agent", "settings.json"), JSON.stringify({ packages: [installed] }));
		await writeFile(
			path.join(root, "agent", "extensions", "reload.js"),
			`export default (pi) => pi.registerCommand("test-reload", { description: "reload", handler: async (_args, ctx) => { await ctx.reload(); } });\n`,
		);

		const notices: string[] = [];
		const responses: Array<() => void> = [];
		let buffer = "";
		pi.stdout.setEncoding("utf8");
		pi.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const message = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (message.type === "response") responses.shift()?.();
				if (message.type === "extension_ui_request" && message.method === "notify") notices.push(message.message);
			}
		});
		const command = (message: string) => new Promise<void>((resolve) => {
			responses.push(resolve);
			pi.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
		});
		const permissionMode = async () => {
			notices.length = 0;
			await command("/computer-use-status");
			return JSON.parse(notices.find((notice) => notice.includes("permissionMode")) ?? "{}").permissionMode;
		};

		assert.equal(await permissionMode(), "no-permissions");
		for (const file of ["src/direct-service.ts", "dist/direct-service.js"]) {
			const target = path.join(installed, file);
			await writeFile(target, (await readFile(target, "utf8")).replaceAll('"no-permissions"', '"updated"'));
		}
		await command("/test-reload");
		assert.equal(await permissionMode(), "updated");
	} finally {
		// On Windows, pi runs under a shell, which does not pass the kill on to it.
		if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pi.pid), "/T", "/F"]);
		else pi.kill();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
