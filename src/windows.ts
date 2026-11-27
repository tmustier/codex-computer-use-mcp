import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Windows counterparts of the macOS-specific parts of the cua_repl transport. ChatGPT for Windows keeps
 * Codex under %LOCALAPPDATA%\OpenAI\Codex and writes the same unified-computer-use plugin settings as on
 * macOS, but launches cua_repl through Node with @oai/cua-repl's launcher instead of a shell wrapper.
 */

export const OPENAI_SIGNER_ORGANIZATION = "OpenAI OpCo, LLC";
/** Relative to %LOCALAPPDATA%. */
export const CODEX_BIN_RELATIVE_PATH = path.join("OpenAI", "Codex", "bin");
/** ChatGPT's Windows launch passes this module to Node with --import; it requests ChatGPT's browser access grant. */
export const BROWSER_ACCESS_BOOTSTRAP = "require-browser-access.mjs";
/** The Windows helper, preferring the one for this process's architecture as Ross Zhu's 0.6 port did. */
export const WINDOWS_HELPER_RELATIVE_PATHS = (process.arch === "arm64"
	? ["codex-computer-use-arm64.exe", "codex-computer-use.exe"]
	: ["codex-computer-use.exe", "codex-computer-use-arm64.exe"]).map((name) => path.join("@oai", "sky", "bin", "windows", name));

interface CommandResult {
	status: number | null;
	stdout?: string;
	stderr?: string;
}

/** The newest entry of `root/<version>/<file>` by modification time. ChatGPT keeps one directory per version. */
export function newestVersionedFile(root: string, file: string): string | undefined {
	if (!existsSync(root)) return undefined;
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(root, entry.name, file))
		.filter((candidate) => existsSync(candidate))
		.map((candidate) => ({ candidate, modified: statSync(candidate).mtimeMs }))
		.sort((left, right) => right.modified - left.modified)[0]?.candidate;
}

/** Authenticode is the Windows counterpart of the macOS codesign Team ID check. */
export function authenticodeCheck(binaryPath: string, runSync: (command: string, args: string[]) => CommandResult): string | undefined {
	const literal = binaryPath.replace(/'/g, "''");
	const script = `$signature = Get-AuthenticodeSignature -LiteralPath '${literal}'; [Console]::Out.Write($signature.Status.ToString() + '|' + [string]$signature.SignerCertificate.Subject)`;
	const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const result = runSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
	const output = (result.stdout ?? "").trim();
	const separator = output.indexOf("|");
	if (result.status !== 0 || separator < 0 || output.slice(0, separator) !== "Valid") {
		return `Signature verification failed for ${path.basename(binaryPath)}${separator > 0 ? ` (${output.slice(0, separator)})` : ""}`;
	}
	if (!new RegExp(`(?:^|, )O="?${OPENAI_SIGNER_ORGANIZATION}"?(?:,|$)`).test(output.slice(separator + 1))) {
		return `${path.basename(binaryPath)} is not signed by the expected OpenAI organization`;
	}
	return undefined;
}

/** Drop ChatGPT's browser access bootstrap, by the owner's choice, so browser surfaces need no grant. */
export function withoutBrowserAccessBootstrap(args: string[]): string[] {
	const index = args.findIndex((arg, at) => arg === "--import" && args[at + 1]?.endsWith(BROWSER_ACCESS_BOOTSTRAP));
	return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

/** The account's own profile locations, which the nested runtime needs while the app-server keeps a private one. */
export function realProfileEnv() {
	const profile = process.env.USERPROFILE ?? "";
	return {
		USERPROFILE: profile,
		HOME: process.env.HOME ?? profile,
		APPDATA: process.env.APPDATA ?? path.join(profile, "AppData", "Roaming"),
		LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(profile, "AppData", "Local"),
	};
}

export function windowsBrokerEnv(codexHome: string, tempRoot: string): NodeJS.ProcessEnv {
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const env: NodeJS.ProcessEnv = {
		USERPROFILE: tempRoot,
		HOME: tempRoot,
		APPDATA: path.join(tempRoot, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(tempRoot, "AppData", "Local"),
		CODEX_HOME: codexHome,
		TEMP: tempRoot,
		TMP: tempRoot,
		SystemRoot: systemRoot,
		windir: systemRoot,
		PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
		NO_COLOR: "1",
	};
	for (const key of ["ComSpec", "PATHEXT", "SystemDrive", "USERNAME", "USERDOMAIN", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

/** End the app-server and every process it started. Windows has no process groups to signal. */
export function killProcessTree(pid: number): { outcome: "ended" | "root-exited" } | { outcome: "failed"; reason: string } {
	const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
	const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
	if (result.status === 0) return { outcome: "ended" };
	// taskkill exits 128 when the app-server has already exited; its children then have no parent to find them through.
	if (result.status === 128) return { outcome: "root-exited" };
	return { outcome: "failed", reason: (result.stderr || result.stdout || "taskkill failed").trim() };
}
