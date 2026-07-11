import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "./config.ts";
import type { DirectMethod } from "./tools.ts";

export interface AuditRecord {
	timestamp: string;
	runId: string;
	method: DirectMethod | "invalid_request";
	permissionMode: PermissionMode;
	app: string | null;
	mutating: boolean;
	authorization: "no_permissions_unrestricted" | "none";
	inputBytes: number;
	outcome: string;
	durationMs: number;
	brokerVersion: string | null;
	clientBuild: string | null;
	directCalls: number;
	modelTurnsStarted: number;
	ephemeralThread: boolean | null;
	approvalRequests: number;
	backgroundPreserved: boolean | null;
	brokerCleanupVerified: boolean;
	appLeaseReleased: boolean;
	resultContentTypes: string[];
	resultBytes: number;
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
	fileName = "direct-computer-use.jsonl",
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
