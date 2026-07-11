import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireAppLock, AppBusyError } from "../src/lock.ts";

test("app-lock roots must be private current-user directories, never symlinks", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-lock-path-test."));
	try {
		const permissive = path.join(root, "permissive");
		await mkdir(permissive, { mode: 0o755 });
		await chmod(permissive, 0o755);
		await assert.rejects(() => acquireAppLock(permissive, "com.apple.calculator", "permissive"), /permissions must be private/);
		const real = path.join(root, "real");
		await mkdir(real, { mode: 0o700 });
		const linked = path.join(root, "linked");
		await symlink(real, linked);
		await assert.rejects(() => acquireAppLock(linked, "com.apple.calculator", "linked"), /non-symlink directory/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("same app is exclusively leased while different apps can proceed", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-lock-test."));
	try {
		const calculator = await acquireAppLock(root, "com.apple.calculator", "run-1");
		await assert.rejects(() => acquireAppLock(root, "com.apple.calculator", "run-2"), AppBusyError);
		const dictionary = await acquireAppLock(root, "com.apple.Dictionary", "run-3");
		await dictionary.release();
		await calculator.release();
		const next = await acquireAppLock(root, "com.apple.calculator", "run-4");
		await next.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("lease excludes a second Pi process", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-lock-process-test."));
	try {
		const modulePath = new URL("../src/lock.ts", import.meta.url).pathname;
		const script = `import { acquireAppLock } from ${JSON.stringify(modulePath)}; const lock=await acquireAppLock(${JSON.stringify(root)}, 'com.apple.calculator', 'child'); console.log('LOCKED'); setTimeout(async()=>{await lock.release(); process.exit(0)}, 750);`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			let output = "";
			const timeout = setTimeout(() => reject(new Error("child did not acquire lock")), 3000);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				output += chunk;
				if (output.includes("LOCKED")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
		await assert.rejects(() => acquireAppLock(root, "com.apple.calculator", "parent"), AppBusyError);
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		const lock = await acquireAppLock(root, "com.apple.calculator", "parent-after");
		await lock.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("atomic publication permits exactly one concurrent same-app lease", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-lock-race-test."));
	try {
		const attempts = await Promise.allSettled(
			Array.from({ length: 32 }, (_, index) => acquireAppLock(root, "com.apple.calculator", `race-${index}`)),
		);
		const acquired = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireAppLock>>> => item.status === "fulfilled");
		assert.equal(acquired.length, 1);
		assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason instanceof AppBusyError).length, 31);
		await acquired[0].value.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("kernel lease is automatically released after owner process crash", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-lock-crash-test."));
	try {
		const modulePath = new URL("../src/lock.ts", import.meta.url).pathname;
		const script = `import { acquireAppLock } from ${JSON.stringify(modulePath)}; await acquireAppLock(${JSON.stringify(root)}, 'com.apple.calculator', 'crashed'); console.log('LOCKED'); setInterval(()=>{},1000);`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise<void>((resolve, reject) => {
			let output = "";
			const timeout = setTimeout(() => reject(new Error("child did not acquire lock")), 3000);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				output += chunk;
				if (output.includes("LOCKED")) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		const replacement = await acquireAppLock(root, "com.apple.calculator", "replacement");
		await replacement.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("long selectors use bounded hashed lock filenames", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-lock-long-test."));
	try {
		const lock = await acquireAppLock(root, `/Applications/${"A".repeat(450)}.app`, "long");
		assert.ok(path.basename(lock.path).length < 100);
		await lock.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
