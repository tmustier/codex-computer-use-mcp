import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface LockOwner {
	runId: string;
	pid: number;
	app: string;
	startedAt: string;
}

export class AppBusyError extends Error {
	readonly owner?: Partial<LockOwner>;
	constructor(app: string, owner?: Partial<LockOwner>) {
		super(`${app} is already leased by another native-app task; concurrent same-app access is blocked`);
		this.name = "AppBusyError";
		this.owner = owner;
	}
}

export interface AppLock {
	path: string;
	owner: LockOwner;
	release(): Promise<void>;
}

function lockKey(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

async function readOwner(ownerPath: string): Promise<Partial<LockOwner> | undefined> {
	try {
		return JSON.parse(await readFile(ownerPath, "utf8"));
	} catch {
		return undefined;
	}
}

async function publishOwner(ownerPath: string, owner: LockOwner): Promise<void> {
	const temporary = `${ownerPath}.${process.pid}.${owner.runId}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, ownerPath);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function acquireAppLock(
	stateDir: string,
	app: string,
	runId: string,
	_staleAfterMs = 10 * 60_000,
): Promise<AppLock> {
	const locksDir = path.join(stateDir, "locks");
	await mkdir(locksDir, { recursive: true, mode: 0o700 });
	const key = lockKey(app);
	const lockPath = path.join(locksDir, `${key}.lock`);
	const ownerPath = path.join(locksDir, `${key}.owner.json`);
	const owner: LockOwner = {
		runId,
		pid: process.pid,
		app: `selector-sha256:${key.slice(0, 16)}`,
		startedAt: new Date().toISOString(),
	};

	// lockf is a kernel advisory lock: acquisition is atomic and a crashed owner releases it automatically.
	// The static shell command emits readiness only after lockf owns the file, then blocks on stdin.
	const proc = spawn(
		"/usr/bin/lockf",
		["-t", "0", lockPath, "/bin/sh", "-c", 'printf "LOCKED\\n"; /bin/cat >/dev/null'],
		{ stdio: ["pipe", "pipe", "ignore"], shell: false },
	);
	const acquired = await new Promise<boolean>((resolve, reject) => {
		let output = "";
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		proc.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		proc.once("close", () => finish(false));
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			output += chunk;
			if (output.includes("LOCKED\n")) finish(true);
		});
	});
	if (!acquired) {
		proc.stdin.destroy();
		throw new AppBusyError(app, await readOwner(ownerPath));
	}

	try {
		await publishOwner(ownerPath, owner);
	} catch (error) {
		proc.stdin.end();
		await new Promise<void>((resolve) => proc.once("close", () => resolve()));
		throw error;
	}
	let released = false;
	return {
		path: lockPath,
		owner,
		async release() {
			if (released) return;
			released = true;
			proc.stdin.end();
			if (proc.exitCode === null) await new Promise<void>((resolve) => proc.once("close", () => resolve()));
			const current = await readOwner(ownerPath);
			if (current?.runId === runId) await rm(ownerPath, { force: true });
		},
	};
}
