import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

export interface AuditRecord {
	timestamp: string;
	runId: string;
	operation: string;
	permissionMode: "safe" | "full-permissions";
	app: string | null;
	mutating: boolean;
	cleanupRequested: boolean;
	userConfirmed: boolean;
	authorization: "none" | "explicit_pi_confirmation" | "dictionary_always_allowed" | "full_permissions_config";
	inputBytes: number;
	outcome: string;
	durationMs: number;
	model: string;
	usage: { input: number; cachedInput: number; output: number };
	computerUseCalls: number;
	backgroundPreserved: boolean | null;
	cleanupVerified: boolean | null;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Audit state path must be a non-symlink directory");
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Audit state path must be a non-symlink directory");
	}
	await chmod(directory, 0o700);
}

export async function appendAudit(
	stateDir: string,
	record: AuditRecord,
	fileName = "background-computer-use.jsonl",
): Promise<string> {
	if (path.basename(fileName) !== fileName) throw new Error("Audit filename must not contain a path");
	await ensurePrivateDirectory(stateDir);
	const auditDir = path.join(stateDir, "audit");
	await ensurePrivateDirectory(auditDir);
	const auditPath = path.join(auditDir, fileName);
	const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
	const handle = await open(auditPath, flags, 0o600);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Audit target must be a regular file");
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return auditPath;
}
