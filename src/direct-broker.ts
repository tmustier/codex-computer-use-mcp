import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { CuaReplArguments, CuaReplTool, JsonObject, JsonValue } from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

const CODEX_RELATIVE_PATHS = [
	"Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
	"Contents/Resources/codex",
];
const COMPUTER_USE_APP_RELATIVE_PATH = "computer-use/Codex Computer Use.app";
const SERVICE_RELATIVE_PATH = "Contents/MacOS/SkyComputerUseService";
const CUA_REPL_CACHE_RELATIVE_PATH = ".codex/plugins/cache/openai-bundled/unified-computer-use";
const CUA_REPL_SERVER = "cua_repl";
const CHATGPT_APP_BUNDLE_ID = "com.openai.codex";
const OPENAI_TEAM_ID = "2DC432GLL2";
// agent-default (not a user rule): 2026-11-04. codesign can take longer than 10s after updates or under load.
const VERIFY_COMMAND_TIMEOUT_MS = 30_000;

function outOfStepHint(codexVersion?: string): string {
	const versions = `codex-computer-use-mcp ${PACKAGE_VERSION}${codexVersion ? `, ${codexVersion}` : ""}`;
	return `ChatGPT and codex-computer-use-mcp may be out of step (${versions}). Open ChatGPT so it can install updates (\`open -a ChatGPT\`), update codex-computer-use-mcp to its latest release, restart Pi or the MCP client, then retry. If it still fails, tell the user.`;
}

// What official node_repl reports when the shared Computer Use service does not answer.
const STUCK_SERVICE_ERROR = "Sky Computer Use native pipe startup failed";
const STUCK_SERVICE_HINT = "The Computer Use service may be stuck. Restart it with `pkill -f MacOS/SkyComputerUseService` (it relaunches on the next call, with or without ChatGPT running), then retry once. If it fails again, ask the user to relaunch ChatGPT.";

const jsonObjectSchema = z.record(z.string(), z.json());
const elicitationRequestSchema = z.object({
	mode: z.string().optional(),
	message: z.string().optional(),
	requestedSchema: z.json().optional(),
	url: z.string().optional(),
	elicitationId: z.string().optional(),
	_meta: z.json().optional(),
}).catchall(z.json());
const directResultSchema = z.object({
	content: z.array(jsonObjectSchema),
	structuredContent: z.json().optional(),
	isError: z.boolean().optional(),
});
const protocolMessageSchema = z.object({
	id: z.union([z.string(), z.number(), z.null()]).optional(),
	method: z.string().optional(),
	params: z.json().optional(),
	result: z.json().optional(),
	error: z.object({ message: z.string().optional() }).catchall(z.json()).optional(),
}).catchall(z.json());
const threadStartSchema = z.object({ thread: z.object({ id: z.string() }) });

export type DirectBrokerElicitationRequest = z.infer<typeof elicitationRequestSchema>;

export interface DirectBrokerElicitationResponse {
	action: "accept" | "decline" | "cancel";
	content?: JsonValue;
	_meta?: JsonValue;
}

export interface DirectBrokerResult {
	content: JsonObject[];
	structuredContent?: JsonValue;
	isError: boolean;
	brokerVersion: string;
	clientBuild: string;
	elicitationRequests: number;
	modelTurnsStarted: 0;
	ephemeralThread: true;
	brokerCleanupVerified: boolean;
}

export interface DirectBrokerOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onElicitation?: (
		request: DirectBrokerElicitationRequest,
	) => DirectBrokerElicitationResponse | Promise<DirectBrokerElicitationResponse>;
	supportsOpenAiFormElicitation?: boolean;
	/** Test-only executable override. Production callers never set this. */
	appServerCommand?: string;
	/** Test-only argument override. */
	appServerArgs?: string[];
	/** Test-only signature bypass. */
	skipSignatureVerification?: boolean;
	/** Test-only process-enumerator override. */
	processEnumeratorCommand?: string;
	onSpawn?: (pid: number) => void;
	/** Path configuration file; see `readOfficialPathConfig`. */
	configPath?: string;
}

class BrokerVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokerVerificationError";
	}
}

export class DirectBrokerCallError extends Error {
	readonly cleanupVerified: boolean;
	readonly directCalls: number;
	readonly modelTurnsStarted: number;
	readonly ephemeralThread: boolean;
	readonly elicitationRequests: number;
	readonly brokerVersion: string;
	readonly clientBuild: string;
	constructor(
		message: string,
		cleanupVerified: boolean,
		cause?: unknown,
		evidence: {
			directCalls?: number;
			modelTurnsStarted?: number;
			ephemeralThread?: boolean;
			elicitationRequests?: number;
			brokerVersion?: string;
			clientBuild?: string;
		} = {},
	) {
		super(message, { cause });
		this.name = "DirectBrokerCallError";
		this.cleanupVerified = cleanupVerified;
		this.directCalls = evidence.directCalls ?? 0;
		this.modelTurnsStarted = evidence.modelTurnsStarted ?? 0;
		this.ephemeralThread = evidence.ephemeralThread ?? false;
		this.elicitationRequests = evidence.elicitationRequests ?? 0;
		this.brokerVersion = evidence.brokerVersion ?? "unknown";
		this.clientBuild = evidence.clientBuild ?? "unknown";
	}
}

interface CommandResult {
	status: number | null;
	stdout?: string;
	stderr?: string;
}

type RunSync = (command: string, args: string[]) => CommandResult;

function productionRunSync(command: string, args: string[]): CommandResult {
	return spawnSync(command, args, { encoding: "utf8", timeout: VERIFY_COMMAND_TIMEOUT_MS });
}

function verifySignedBinary(binaryPath: string, runSync: RunSync): void {
	const name = path.basename(binaryPath);
	const verify = runSync("/usr/bin/codesign", ["--verify", "--strict", binaryPath]);
	if (verify.status === null) {
		throw new BrokerVerificationError(`Could not check the signature of ${name}: codesign did not finish within ${VERIFY_COMMAND_TIMEOUT_MS / 1000} seconds. ChatGPT may be updating, or the Mac is busy. Wait a minute, then retry.`);
	}
	if (verify.status !== 0) {
		const reason = (verify.stderr ?? "").trim().split("\n")[0].slice(0, 300);
		throw new BrokerVerificationError(`Signature verification failed for ${name}${reason ? ` (${reason})` : ""}. If ChatGPT is updating, wait for it to finish and retry. Otherwise reinstall ChatGPT from https://chatgpt.com/download.`);
	}
	const details = runSync("/usr/bin/codesign", ["-dv", "--verbose=2", binaryPath]);
	const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
	if (details.status !== 0 || !new RegExp(`(?:^|\\n)TeamIdentifier=${OPENAI_TEAM_ID}(?:\\n|$)`).test(output)) {
		throw new BrokerVerificationError(`${path.basename(binaryPath)} is not signed by the expected OpenAI team`);
	}
}

const pathConfigSchema = z.object({
	codexPath: z.string().min(1).optional(),
	cuaReplConfigPath: z.string().min(1).optional(),
});

export type OfficialPathConfig = z.infer<typeof pathConfigSchema>;

export function pathConfigFile(stateRoot: string): string {
	return path.join(stateRoot, "config.json");
}

/** Read optional path overrides. A missing file means the default official locations. */
export function readOfficialPathConfig(configPath: string): OfficialPathConfig {
	if (!existsSync(configPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		throw new BrokerVerificationError(`Computer Use config at ${configPath} is not valid JSON`);
	}
	const config = pathConfigSchema.safeParse(parsed);
	if (!config.success) {
		throw new BrokerVerificationError(`Computer Use config at ${configPath} must set "codexPath" and "cuaReplConfigPath", when present, to path strings`);
	}
	return config.data;
}

function notFoundError(component: string, checked: string[], key: keyof OfficialPathConfig, hint: string, configPath?: string, installedChatGpt?: string): BrokerVerificationError {
	const where = configPath ? `in ${configPath}` : "in the Computer Use config.json in the state directory";
	const moved = installedChatGpt ? ` ChatGPT is installed at ${installedChatGpt}; if it is up to date, an update may have moved this file. ${outOfStepHint()}` : "";
	return new BrokerVerificationError(
		`${component} was not found. Checked: ${checked.join(", ")}. ${hint}${moved} If it is installed elsewhere, set "${key}" to its absolute path ${where}, or remove "${key}" to restore automatic discovery.`,
	);
}

function defaultChatGptAppPaths(userHome = os.userInfo().homedir): string[] {
	return ["/Applications/ChatGPT.app", path.join(userHome, "Applications", "ChatGPT.app")];
}

/**
 * The default locations first, then any other app Spotlight indexes under ChatGPT's bundle ID, such as
 * an install still named Codex.app because the separate classic ChatGPT app occupies ChatGPT.app.
 */
function installedChatGptAppPaths(defaultApps: string[], runSync: RunSync): string[] {
	const indexed = runSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${CHATGPT_APP_BUNDLE_ID}"`]);
	const indexedApps = indexed.status === 0 ? (indexed.stdout ?? "").split("\n").filter((line) => line.endsWith(".app")) : [];
	return [...new Set([...defaultApps, ...indexedApps])];
}

interface ResolveOfficialOptions {
	/** Test-only OS-account home override. Production never reads HOME or CODEX_HOME. */
	userHome?: string;
	/** Test-only override of the default ChatGPT app locations. */
	chatGptAppPaths?: string[];
	configPath?: string;
	runSync?: RunSync;
}

/** Find the configured Codex app-server executable, or else the first default ChatGPT location that exists. */
function locateOfficialCodex(options: ResolveOfficialOptions = {}): string {
	const runSync = options.runSync ?? productionRunSync;
	const config = options.configPath ? readOfficialPathConfig(options.configPath) : {};
	const chatGptApps = config.codexPath ? [] : installedChatGptAppPaths(options.chatGptAppPaths ?? defaultChatGptAppPaths(options.userHome), runSync);
	const candidates = config.codexPath ? [path.resolve(config.codexPath)]
		: chatGptApps.flatMap((app) => CODEX_RELATIVE_PATHS.map((relative) => path.join(app, relative)));
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw notFoundError(
			"Codex app-server",
			candidates,
			"codexPath",
			"Install or update the official ChatGPT macOS app (https://chatgpt.com/download), then open it.",
			options.configPath,
			chatGptApps.find((app) => existsSync(app)),
		);
	}
	return realpathSync(found);
}

/** Resolve and verify the Codex app-server executable. */
export function resolveOfficialCodex(options: ResolveOfficialOptions = {}): string {
	const codexPath = locateOfficialCodex(options);
	verifySignedBinary(codexPath, options.runSync ?? productionRunSync);
	return codexPath;
}

const cuaReplServerSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).default({}),
}).catchall(z.json());
const cuaReplConfigSchema = z.object({ mcpServers: z.object({ cua_repl: cuaReplServerSchema }) });

export type CuaReplServer = z.infer<typeof cuaReplServerSchema>;

export interface OfficialCuaRepl {
	/** The `.mcp.json` that ChatGPT generated for its unified Computer Use plugin. */
	configPath: string;
	/** ChatGPT's `cua_repl` MCP server entry, passed to the app-server unchanged apart from `cwd`. */
	server: CuaReplServer;
	nodeReplPath: string;
	computerUseAppPath: string;
	clientBuild: string;
}

function plistValue(appPath: string, key: string, runSync: RunSync): string | undefined {
	const result = runSync("/usr/bin/plutil", ["-extract", key, "raw", path.join(appPath, "Contents", "Info.plist")]);
	const value = (result.stdout ?? "").trim();
	return result.status === 0 && value ? value : undefined;
}

function verifiedExecutable(executable: string, runSync: RunSync): string {
	if (!existsSync(executable)) {
		throw new BrokerVerificationError(`${executable}, named by ChatGPT's Computer Use config, does not exist. ${outOfStepHint()}`);
	}
	const canonical = realpathSync(executable);
	verifySignedBinary(canonical, runSync);
	return canonical;
}

/**
 * Read ChatGPT's own cua_repl server entry without verifying it. ChatGPT writes it, with this account's
 * paths filled in, to its plugin cache when it starts; the copy for the installed ChatGPT version is
 * authoritative.
 */
interface CuaReplServerSource {
	configPath: string;
	server: CuaReplServer;
}

function readCuaReplServer(codexPath: string, options: ResolveOfficialOptions): CuaReplServerSource {
	const runSync = options.runSync ?? productionRunSync;
	const config = options.configPath ? readOfficialPathConfig(options.configPath) : {};
	const userHome = options.userHome ?? os.userInfo().homedir;
	let configPath = config.cuaReplConfigPath ? path.resolve(config.cuaReplConfigPath) : undefined;
	if (!configPath) {
		const chatGptApp = /^(.*?\.app)\/Contents\/Resources\//.exec(codexPath)?.[1];
		const version = chatGptApp ? plistValue(chatGptApp, "CFBundleShortVersionString", runSync) : undefined;
		if (!chatGptApp || !version) {
			throw new BrokerVerificationError(`Could not tell which ChatGPT version contains ${codexPath}. Set "cuaReplConfigPath" to ChatGPT's unified-computer-use .mcp.json ${options.configPath ? `in ${options.configPath}` : "in the Computer Use config.json in the state directory"}.`);
		}
		configPath = path.join(userHome, CUA_REPL_CACHE_RELATIVE_PATH, version, ".mcp.json");
		if (!existsSync(configPath)) {
			throw new BrokerVerificationError(`ChatGPT ${version} has not prepared its Computer Use runtime yet (expected ${configPath}). Open ChatGPT (\`open -a ChatGPT\`) and wait for it to finish starting, then retry. If the file is still missing, this ChatGPT build does not include the unified Computer Use plugin; update ChatGPT, or tell the user.`);
		}
	}
	let server: CuaReplServer;
	try {
		server = cuaReplConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))).mcpServers.cua_repl;
	} catch (error) {
		if (!existsSync(configPath)) throw notFoundError("ChatGPT's Computer Use config", [configPath], "cuaReplConfigPath", "Open ChatGPT so it can prepare Computer Use.", options.configPath);
		throw new BrokerVerificationError(`ChatGPT's Computer Use config at ${configPath} has an unexpected shape (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). ${outOfStepHint()}`);
	}
	return { configPath, server };
}

/** Read ChatGPT's cua_repl server entry for the installed ChatGPT, without signature checks, to describe its tools. */
export function readOfficialCuaReplServer(options: ResolveOfficialOptions = {}): CuaReplServer {
	return readCuaReplServer(locateOfficialCodex(options), options).server;
}

/** Read ChatGPT's cua_repl server entry and verify every official executable it names. */
export function resolveOfficialCuaRepl(codexPath: string, options: ResolveOfficialOptions = {}): OfficialCuaRepl {
	const runSync = options.runSync ?? productionRunSync;
	const userHome = options.userHome ?? os.userInfo().homedir;
	const { configPath, server } = readCuaReplServer(codexPath, options);
	const nodeRepls = [server.command, ...server.args].filter((part) => path.isAbsolute(part) && path.basename(part) === "node_repl");
	if (nodeRepls.length !== 1) {
		throw new BrokerVerificationError(`ChatGPT's Computer Use config at ${configPath} does not name exactly one node_repl executable. ${outOfStepHint()}`);
	}
	const nodeReplPath = verifiedExecutable(nodeRepls[0]!, runSync);
	if (server.env.NODE_REPL_NODE_PATH) verifiedExecutable(server.env.NODE_REPL_NODE_PATH, runSync);
	const computerUseAppPath = server.env.SKY_CUA_SERVICE_PATH ?? path.join(userHome, ".codex", COMPUTER_USE_APP_RELATIVE_PATH);
	const servicePath = path.join(computerUseAppPath, SERVICE_RELATIVE_PATH);
	if (!existsSync(servicePath)) {
		throw notFoundError("Official Computer Use service", [servicePath], "cuaReplConfigPath", "Open ChatGPT and install its Computer Use component.", options.configPath);
	}
	verifySignedBinary(realpathSync(servicePath), runSync);
	const clientBuild = plistValue(computerUseAppPath, "CFBundleVersion", runSync);
	if (!clientBuild) throw new BrokerVerificationError("Could not verify the official Computer Use build");
	return { configPath, server, nodeReplPath, computerUseAppPath, clientBuild };
}

export function verifyOfficialDirectBroker(options: ResolveOfficialOptions = {}) {
	const runSync = options.runSync ?? productionRunSync;
	const codexPath = resolveOfficialCodex({ ...options, runSync });
	const version = runSync(codexPath, ["--version"]);
	if (version.status !== 0 || !/^codex-cli\s+\d+\./.test((version.stdout ?? "").trim())) {
		throw new BrokerVerificationError("Could not verify the app-bundled Codex app-server version");
	}
	const cuaRepl = resolveOfficialCuaRepl(codexPath, { ...options, runSync });
	return { brokerVersion: (version.stdout ?? "").trim(), clientBuild: cuaRepl.clientBuild, cuaRepl, codexPath };
}

function buildBrokerEnv(codexHome: string, tempRoot: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: tempRoot,
		CODEX_HOME: codexHome,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tempRoot,
		NO_COLOR: "1",
		CLICOLOR: "0",
	};
	for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

function normalizeBrokerError(error: Error, stderr: string): Error {
	return /authentication|bearer|token/i.test(`${error.message}\n${stderr}`)
		? new Error("Official direct Computer Use broker reported an authentication failure", { cause: error })
		: error;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

class ProcessEnumerationError extends Error {
	readonly partialPids: Set<number>;
	constructor(message: string, partialPids: Set<number>, cause?: unknown) {
		super(message, { cause });
		this.name = "ProcessEnumerationError";
		this.partialPids = new Set(partialPids);
	}
}

function collectDescendants(rootPid: number, processEnumeratorCommand = "/usr/bin/pgrep"): Set<number> {
	const descendants = new Set<number>();
	const queue = [rootPid];
	while (queue.length > 0) {
		if (descendants.size >= 256) {
			throw new ProcessEnumerationError("Official app-server process tree exceeded the cleanup bound", descendants);
		}
		const parent = queue.shift()!;
		const result = spawnSync(processEnumeratorCommand, ["-P", String(parent)], { encoding: "utf8", timeout: 2000 });
		if (
			result.error
			|| (result.status !== 0 && result.status !== 1)
			|| (result.status === 1 && (result.stderr ?? "").trim().length > 0)
		) {
			throw new ProcessEnumerationError("Could not enumerate the official app-server process tree", descendants, result.error);
		}
		for (const token of (result.stdout ?? "").trim().split(/\s+/)) {
			const child = Number(token);
			if (!Number.isSafeInteger(child) || child <= 1 || child === rootPid || descendants.has(child)) continue;
			descendants.add(child);
			queue.push(child);
		}
	}
	return descendants;
}

function collectProcessesWithCwd(workDir: string): Set<number> {
	const result = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "+d", workDir, "-Fp"], {
		encoding: "utf8",
		timeout: 3000,
	});
	if (
		result.error
		|| (result.status !== 0 && result.status !== 1)
		|| (result.status === 1 && (result.stderr ?? "").trim().length > 0)
	) {
		throw new ProcessEnumerationError("Could not enumerate processes owned by the private broker working directory", new Set(), result.error);
	}
	const pids = new Set<number>();
	for (const line of (result.stdout ?? "").split("\n")) {
		const match = line.match(/^p(\d+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid);
	}
	return pids;
}

async function terminateGroup(
	proc: ChildProcessWithoutNullStreams | undefined,
	workDir: string,
	processEnumeratorCommand = "/usr/bin/pgrep",
): Promise<void> {
	const pid = proc?.pid;
	if (!pid) return;
	const descendants = new Set<number>();
	const rootWasAlive = processExists(pid);
	let cleanupError: Error | undefined;
	const enumerate = (): Set<number> => {
		const found = new Set<number>();
		try {
			for (const child of collectDescendants(pid, processEnumeratorCommand)) found.add(child);
		} catch (error) {
			if (error instanceof ProcessEnumerationError) {
				for (const child of error.partialPids) found.add(child);
			}
			cleanupError ??= error instanceof Error ? error : new Error(String(error));
		}
		try {
			for (const owned of collectProcessesWithCwd(workDir)) found.add(owned);
		} catch (error) {
			if (error instanceof ProcessEnumerationError) {
				for (const owned of error.partialPids) found.add(owned);
			}
			cleanupError ??= error instanceof Error ? error : new Error(String(error));
		}
		return found;
	};
	for (const child of enumerate()) descendants.add(child);

	let rootFrozen = false;
	try {
		process.kill(-pid, "SIGSTOP");
		rootFrozen = true;
	} catch {
		try {
			proc.kill("SIGSTOP");
			rootFrozen = processExists(pid);
		} catch { /* already exited */ }
	}
	if (rootWasAlive && !rootFrozen) cleanupError ??= new Error("Could not freeze the official app-server before cleanup");

	let stable = false;
	for (let pass = 0; pass < 16; pass += 1) {
		let added = false;
		for (const child of enumerate()) {
			if (!descendants.has(child)) {
				descendants.add(child);
				added = true;
			}
			try { process.kill(child, "SIGSTOP"); }
			catch { if (processExists(child)) cleanupError ??= new Error("Could not freeze an app-server-owned process"); }
		}
		if (!added && pass > 0) { stable = true; break; }
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!stable) cleanupError ??= new Error("Official app-server process tree did not stabilize for cleanup");

	for (const child of descendants) {
		try { process.kill(child, "SIGKILL"); } catch { /* exited */ }
	}
	try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* exited */ } }
	for (let pass = 0; pass < 2; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		for (const owned of enumerate()) {
			descendants.add(owned);
			try { process.kill(owned, "SIGKILL"); } catch { /* exited */ }
		}
	}
	for (let elapsed = 0; elapsed < 1500; elapsed += 25) {
		if (!processExists(-pid) && [...descendants].every((child) => !processExists(child))) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	let cwdSurvivors = new Set<number>();
	try { cwdSurvivors = collectProcessesWithCwd(workDir); }
	catch (error) { cleanupError ??= error instanceof Error ? error : new Error(String(error)); }
	for (const survivor of cwdSurvivors) {
		try { process.kill(survivor, "SIGKILL"); } catch { /* exited */ }
	}
	if (processExists(-pid) || [...descendants, ...cwdSurvivors].some((child) => processExists(child))) {
		cleanupError ??= new Error("Official app-server process tree did not terminate");
	}
	if (cleanupError) throw cleanupError;
}

/** Serialise JSON as a TOML value for the app-server's `-c key=value` overrides. */
function toToml(value: JsonValue): string {
	if (value === null) throw new Error("TOML has no null value");
	if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
	if (value instanceof Object) {
		const entries = Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
		return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)} = ${toToml(item)}`).join(", ")} }`;
	}
	// JSON strings, numbers and booleans are valid TOML once DEL, which JSON leaves raw, is escaped.
	return JSON.stringify(value).replaceAll("\u007f", "\\u007F");
}

type RequestKind = "control" | "tool" | "turn-end" | "cleanup";

export interface OfficialCuaReplSession {
	call(
		tool: CuaReplTool,
		args: CuaReplArguments,
		options?: Pick<DirectBrokerOptions, "timeoutMs" | "signal" | "onElicitation">,
	): Promise<DirectBrokerResult>;
	/** Tell the official runtime this agent turn ended, as ChatGPT's Stop hook does. REPL bindings survive. */
	endTurn(): Promise<void>;
	close(): Promise<void>;
}

export async function createOfficialCuaReplSession(
	options: DirectBrokerOptions = {},
): Promise<OfficialCuaReplSession> {
	const verification = options.skipSignatureVerification
		? { brokerVersion: "test-app-server", clientBuild: "test-client", server: undefined, codexPath: undefined }
		: (() => {
			const verified = verifyOfficialDirectBroker({ configPath: options.configPath });
			return { ...verified, server: verified.cuaRepl.server };
		})();
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-direct-computer-use."));
	const codexHome = path.join(tempRoot, "codex-home");
	const workDir = path.join(tempRoot, "work");
	await mkdir(codexHome, { mode: 0o700 });
	await mkdir(workDir, { mode: 0o700 });
	await writeFile(path.join(codexHome, "config.toml"), "", { mode: 0o600 });
	await chmod(codexHome, 0o700);

	let proc: ChildProcessWithoutNullStreams | undefined;
	let processClosed: Promise<void> | undefined;
	let termination: Promise<void> | undefined;
	let fatalError: Error | undefined;
	let stderr = "";
	let nextId = 1;
	let modelTurnsStarted = 0;
	let ephemeralThread = false;
	let threadId = "";
	let turnId = randomUUID();
	let turnActive = false;
	let cleanupRequestId: string | undefined;
	let toolResponse: { id: string; done: Promise<void>; finish(): void } | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let callActive = false;
	let currentElicitation: DirectBrokerOptions["onElicitation"];
	let currentElicitationCount = 0;
	const pending = new Map<string, { resolve(value: JsonValue): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	const rejectAll = (error: Error): void => {
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		pending.clear();
	};
	const ensureTerminated = (): Promise<void> => {
		termination ??= terminateGroup(proc, workDir, options.processEnumeratorCommand);
		return termination;
	};
	const fail = (error: Error): void => {
		fatalError ??= error;
		rejectAll(fatalError);
		void ensureTerminated().catch(() => undefined);
	};
	const cancel = (error: Error): void => {
		fatalError ??= error;
		rejectAll(fatalError);
		// Cancellation and tool timeouts leave the signed transport usable.
		void close().catch(() => undefined);
	};
	const send = (message: JsonValue): void => {
		if (!proc?.stdin.writable) throw new Error("Official app-server stdin is unavailable");
		proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
	};
	const request = (methodName: string, params: JsonValue, timeoutMs: number, kind: RequestKind = "control"): Promise<JsonValue> => {
		const id = String(nextId++);
		if (kind === "cleanup") cleanupRequestId = id;
		if (kind === "tool") {
			let finish!: () => void;
			const done = new Promise<void>((resolve) => { finish = resolve; });
			toolResponse = { id, done, finish };
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				const recovery = kind === "tool"
					? `The target app may be unresponsive. ${STUCK_SERVICE_HINT}`
					: `Retry once. If it times out again: ${outOfStepHint(verification.brokerVersion)}`;
				const error = new Error(`Official app-server request timed out: ${methodName}. ${recovery}`);
				reject(error);
				if (kind === "tool") cancel(error);
				// A stalled turn-ended notification must not fail the session.
				else if (kind === "control") fail(error);
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try { send({ method: methodName, id, params }); }
			catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				if (toolResponse?.id === id) { toolResponse.finish(); toolResponse = undefined; }
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};
	const toolCall = (tool: string, args: JsonObject, timeoutMs: number, kind: RequestKind) => request("mcpServer/tool/call", {
		threadId, server: CUA_REPL_SERVER, tool, arguments: args,
		_meta: { "x-codex-turn-metadata": { thread_id: threadId, session_id: threadId, turn_id: turnId } },
	}, timeoutMs, kind);
	const drainToolResponse = (timeoutMs: number): Promise<boolean> => {
		if (!toolResponse) return Promise.resolve(true);
		const response = toolResponse;
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			void response.done.then(() => { clearTimeout(timer); resolve(true); });
		});
	};
	// Best effort: the turn's requests already ran, so their results stand. At worst the
	// shared service keeps showing this session's cursor.
	const sendTurnEnded = async (kind: "turn-end" | "cleanup"): Promise<void> => {
		if (!turnActive) return;
		turnActive = false;
		try {
			await toolCall("turn_ended", { hook_event_name: "Stop", session_id: threadId, turn_id: turnId }, 3_000, kind);
		} catch { /* see above */ }
		turnId = randomUUID();
	};

	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			closed = true;
			rejectAll(new Error("Official app-server closed"));
			// A rejected caller is not a completed native request. Ending its turn too
			// early can let the late request recreate the cursor.
			if (turnActive && !termination && proc?.stdin.writable && await drainToolResponse(1_000) && !termination) {
				await sendTurnEnded("cleanup");
			}
			let cleanupError: Error | undefined;
			try {
				await ensureTerminated();
				if (processClosed) {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("Official app-server stdio did not close")), 1_000);
						processClosed!.then(() => { clearTimeout(timer); resolve(); });
					});
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
				await rm(tempRoot, { recursive: true, force: true });
			} catch (error) {
				cleanupError = error instanceof Error ? error : new Error(String(error));
			}
			if (cleanupError) throw new Error("Official direct Computer Use broker cleanup failed", { cause: cleanupError });
			if (fatalError || modelTurnsStarted !== 0) throw fatalError ?? new BrokerVerificationError("Model-turn activity was observed during broker teardown");
		})();
		return closePromise;
	};

	try {
		const command = options.appServerCommand ?? verification.codexPath;
		if (!command) throw new BrokerVerificationError("The Codex app-server was not verified");
		let commandArgs = options.appServerArgs;
		if (!commandArgs) {
			assert(verification.server && verification.codexPath, "Test brokers must supply appServerArgs");
			// ChatGPT launches node_repl through a shell that exports BROWSER_USE_ACCESS_EXECUTOR_ID,
			// empty when ChatGPT supplies none. Any value makes the runtime ask ChatGPT's per-turn browser
			// access grant host, which only ChatGPT runs. By the owner's choice, node_repl starts directly so
			// browser surfaces work without that grant. The app-server runs with a private HOME; the
			// runtime finds the shared Computer Use service socket under the account's real home.
			const launch = [verification.server.command, ...verification.server.args];
			const nodeRepl = launch.findIndex((part) => path.isAbsolute(part) && path.basename(part) === "node_repl");
			const server = {
				...verification.server,
				command: launch[nodeRepl]!,
				args: launch.slice(nodeRepl + 1),
				env: { ...verification.server.env, HOME: os.userInfo().homedir },
				cwd: workDir,
				enabled: true,
			};
			const mcpTable = toToml({ [CUA_REPL_SERVER]: server });
			const disabledProvider = '{ name = "Direct dispatch disabled provider", base_url = "http://127.0.0.1:9/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_websockets = false, requires_openai_auth = false }';
			commandArgs = [
				"-c", 'model_provider="direct_disabled"',
				"-c", 'model="direct-disabled"',
				"-c", `model_providers.direct_disabled=${disabledProvider}`,
				"-c", "features.shell_tool=false",
				"-c", "features.unified_exec=false",
				"-c", "features.multi_agent=false",
				"-c", "features.memories=false",
				"-c", "memories.use_memories=false",
				"-c", "memories.generate_memories=false",
				"-c", "features.remote_plugin=false",
				"-c", "features.plugins=false",
				"-c", "features.remote_control=false",
				"-c", "features.hooks=false",
				"-c", "analytics.enabled=false",
				"-c", 'otel.exporter="none"',
				"-c", 'web_search="disabled"',
				"-c", 'history.persistence="none"',
				"-c", `mcp_servers=${mcpTable}`,
				"-c", "plugins={}",
				"app-server", "--stdio",
			];
		}
		proc = spawn(command, commandArgs, {
			cwd: workDir,
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: buildBrokerEnv(codexHome, tempRoot),
		});
		const spawnedProcess = proc;
		processClosed = new Promise((resolve) => spawnedProcess.once("close", () => resolve()));
		if (proc.pid) options.onSpawn?.(proc.pid);
		proc.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") fail(error); });
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
		proc.once("error", (error) => fail(error));
		proc.once("close", (code) => {
			if (pending.size === 0) return;
			// eslint-disable-next-line no-control-regex
			const output = stderr.replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n").slice(-6).join("\n").slice(-1_000);
			fail(new Error(`Official app-server exited before completing the request (${code ?? "unknown"})${output ? `. It reported:\n${output}\n` : ". "}${outOfStepHint(verification.brokerVersion)}`));
		});

		const processProtocolLine = (line: string): void => {
			let parsedMessage: ReturnType<typeof protocolMessageSchema.safeParse>;
			try { parsedMessage = protocolMessageSchema.safeParse(JSON.parse(line)); }
			catch { fail(new Error("Official app-server emitted malformed JSONL")); return; }
			if (!parsedMessage.success) { fail(new Error("Official app-server emitted an invalid protocol message")); return; }
			const message = parsedMessage.data;
			if (message.method?.startsWith("turn/") || message.method?.startsWith("item/")) {
				modelTurnsStarted += 1;
				fail(new Error("Official app-server unexpectedly emitted model-turn activity during direct dispatch"));
				return;
			}
			if (toolResponse?.id === String(message.id) && (message.result !== undefined || message.error !== undefined)) {
				toolResponse.finish();
				toolResponse = undefined;
			}
			// After shutdown starts, only its own reply may complete. Continue
			// detecting malformed output and model activity before this filter.
			if ((fatalError || closed) && String(message.id) !== cleanupRequestId) return;
			try {
				if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
					const waiter = pending.get(String(message.id));
					if (!waiter) return;
					pending.delete(String(message.id));
					clearTimeout(waiter.timer);
					if (message.error) waiter.reject(new Error(`Official app-server error: ${message.error.message ?? "unknown"}. ${outOfStepHint(verification.brokerVersion)}`));
					else waiter.resolve(message.result ?? null);
					return;
				}
				if (message.id != null && message.method) {
					if (message.method !== "mcpServer/elicitation/request") {
						send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
						return;
					}
					currentElicitationCount += 1;
					const requestParams = elicitationRequestSchema.parse(message.params ?? {});
					void (async () => {
						let response: DirectBrokerElicitationResponse = { action: "cancel" };
						try {
							if (currentElicitation) response = await currentElicitation(requestParams);
						} catch { response = { action: "cancel" }; }
						if (fatalError || closed || !proc?.stdin.writable) return;
						send({ id: message.id, result: { ...response } });
					})().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
				}
			} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		};
		const stdoutLines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		stdoutLines.on("line", processProtocolLine);

		await request("initialize", {
			clientInfo: { name: "pi_direct_computer_use", title: "Pi Direct Computer Use", version: PACKAGE_VERSION },
			capabilities: { mcpServerOpenaiFormElicitation: options.supportsOpenAiFormElicitation === true },
		}, 15_000);
		send({ method: "initialized" });
		const started = threadStartSchema.parse(await request("thread/start", {
			cwd: workDir, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true, serviceName: "pi_direct_computer_use",
		}, 30_000));
		threadId = started.thread.id;
		ephemeralThread = true;
	} catch (error) {
		const primary = normalizeBrokerError(error instanceof Error ? error : new Error(String(error)), stderr);
		try { await close(); }
		catch (closeError) {
			const closeFailure = closeError instanceof Error ? closeError : new Error(String(closeError));
			if (closeFailure.message === "Official direct Computer Use broker cleanup failed") {
				throw new DirectBrokerCallError(closeFailure.message, false, primary);
			}
		}
		throw new DirectBrokerCallError(primary.message, true, primary, { modelTurnsStarted, ephemeralThread, brokerVersion: verification.brokerVersion, clientBuild: verification.clientBuild });
	}

	return {
		async call(tool, args, callOptions = {}) {
			if (closed) throw new DirectBrokerCallError("Official direct Computer Use session is closed", true);
			if (callActive) throw new DirectBrokerCallError("Official direct Computer Use session does not allow concurrent calls", false);
			callActive = true;
			currentElicitation = callOptions.onElicitation;
			currentElicitationCount = 0;
			let directCalls = 0;
			let abortHandler: (() => void) | undefined;
			try {
				if (callOptions.signal) {
					abortHandler = () => cancel(new Error("Direct Computer Use request cancelled"));
					if (callOptions.signal.aborted) abortHandler();
					else callOptions.signal.addEventListener("abort", abortHandler, { once: true });
				}
				if (fatalError) throw fatalError;
				turnActive = true;
				const raw = await toolCall(tool, args, callOptions.timeoutMs ?? 120_000, "tool");
				directCalls = 1;
				if (modelTurnsStarted !== 0) throw new BrokerVerificationError("Model-turn activity was observed during direct dispatch");
				const result = directResultSchema.parse(raw);
				const stuck = result.isError && result.content.some((block) => block.type === "text" && String(block.text ?? "").includes(STUCK_SERVICE_ERROR));
				return {
					content: stuck ? [...result.content, { type: "text", text: STUCK_SERVICE_HINT }] : result.content,
					structuredContent: result.structuredContent,
					isError: result.isError === true,
					brokerVersion: verification.brokerVersion,
					clientBuild: verification.clientBuild,
					elicitationRequests: currentElicitationCount,
					modelTurnsStarted: 0,
					ephemeralThread: true,
					brokerCleanupVerified: false,
				};
			} catch (error) {
				const primary = normalizeBrokerError(error instanceof Error ? error : new Error(String(error)), stderr);
				throw new DirectBrokerCallError(primary.message, false, primary, {
					directCalls, modelTurnsStarted, ephemeralThread, elicitationRequests: currentElicitationCount,
					brokerVersion: verification.brokerVersion, clientBuild: verification.clientBuild,
				});
			} finally {
				if (abortHandler && callOptions.signal) callOptions.signal.removeEventListener("abort", abortHandler);
				currentElicitation = undefined;
				callActive = false;
			}
		},
		async endTurn() {
			if (closed || fatalError || callActive) return;
			await sendTurnEnded("turn-end");
		},
		close,
	};
}

/** Run one call in a fresh session, then end its turn and tear the session down. */
export async function callOfficialCuaRepl(
	tool: CuaReplTool,
	args: CuaReplArguments,
	options: DirectBrokerOptions = {},
): Promise<DirectBrokerResult> {
	let session: OfficialCuaReplSession | undefined;
	let result: DirectBrokerResult | undefined;
	let failure: unknown;
	try {
		session = await createOfficialCuaReplSession(options);
		result = await session.call(tool, args, options);
	} catch (error) {
		failure = error;
	}
	let cleanupVerified = failure instanceof DirectBrokerCallError ? failure.cleanupVerified : false;
	try {
		if (session) {
			await session.close();
			cleanupVerified = true;
		}
	} catch (cleanupError) {
		const closeFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
		throw new DirectBrokerCallError(
			closeFailure.message,
			closeFailure.message !== "Official direct Computer Use broker cleanup failed",
			closeFailure,
			failure instanceof DirectBrokerCallError ? failure : {},
		);
	}
	if (failure) {
		if (failure instanceof DirectBrokerCallError) {
			throw new DirectBrokerCallError(failure.message, cleanupVerified, failure, failure);
		}
		throw failure;
	}
	assert(result, "A successful Computer Use call returns a result");
	return { ...result, brokerCleanupVerified: true };
}
