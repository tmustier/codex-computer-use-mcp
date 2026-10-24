import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
async function ensurePrivateDirectory(directory) {
    try {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory())
            throw new Error("Audit state path must be a non-symlink directory");
    }
    catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await chmod(directory, 0o700);
}
export async function appendAudit(stateDir, record) {
    await ensurePrivateDirectory(stateDir);
    const auditDir = path.join(stateDir, "audit");
    await ensurePrivateDirectory(auditDir);
    const auditPath = path.join(auditDir, "direct-computer-use.jsonl");
    const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
    const handle = await open(auditPath, flags, 0o600);
    try {
        if (!(await handle.stat()).isFile())
            throw new Error("Audit target must be a regular file");
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=audit.js.map