import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
export type PermissionMode = "safe" | "full-permissions";

export interface ExtensionConfig {
	version: 1;
	permissionMode: PermissionMode;
}

export const DEFAULT_CONFIG: ExtensionConfig = { version: 1, permissionMode: "safe" };

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export function configPath(stateDir: string): string {
	return path.join(stateDir, "config.json");
}

function parseConfig(value: unknown): ExtensionConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("Computer Use config must be an object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !["version", "permissionMode"].includes(key))) {
		throw new ConfigError("Computer Use config contains unknown keys");
	}
	if (record.version !== 1) throw new ConfigError("Unsupported Computer Use config version");
	if (record.permissionMode !== "safe" && record.permissionMode !== "full-permissions") {
		throw new ConfigError("permissionMode must be safe or full-permissions");
	}
	return { version: 1, permissionMode: record.permissionMode };
}

async function inspectStateDirectory(stateDir: string, create: boolean): Promise<boolean> {
	try {
		const info = await lstat(stateDir);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new ConfigError("Computer Use state must be a non-symlink directory");
		if ((info.mode & 0o022) !== 0) throw new ConfigError("Computer Use state directory must not be group/world writable");
		return true;
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
		if (!create) return false;
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		const info = await lstat(stateDir);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new ConfigError("Computer Use state must be a non-symlink directory");
		await chmod(stateDir, 0o700);
		return true;
	}
}

export async function loadConfig(stateDir: string): Promise<ExtensionConfig> {
	if (!(await inspectStateDirectory(stateDir, false))) return { ...DEFAULT_CONFIG };
	const file = configPath(stateDir);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = await handle.stat();
		if (!info.isFile()) throw new ConfigError("Computer Use config must be a regular non-symlink file");
		if ((info.mode & 0o777) !== 0o600) throw new ConfigError("Computer Use config must have mode 0600");
		return parseConfig(JSON.parse(await handle.readFile("utf8")));
	} catch (error: any) {
		if (error?.code === "ENOENT") return { ...DEFAULT_CONFIG };
		if (error instanceof ConfigError) throw error;
		throw new ConfigError("Could not read the Computer Use config");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function saveConfig(stateDir: string, config: ExtensionConfig): Promise<string> {
	const validated = parseConfig(config);
	await inspectStateDirectory(stateDir, true);
	await chmod(stateDir, 0o700);
	const destination = configPath(stateDir);
	const temporary = path.join(stateDir, `.config.${process.pid}.${Date.now()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
		handle = await open(temporary, flags, 0o600);
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, destination);
		const directory = await open(stateDir, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		return destination;
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true });
	}
}
