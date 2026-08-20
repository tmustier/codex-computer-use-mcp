import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { DirectMethod, DirectToolArguments, JsonObject, JsonValue } from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

const CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const COMPUTER_USE_PLUGIN_ROOT =
	"/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use";
const COMPUTER_USE_APP_RELATIVE_PATH = "computer-use/Codex Computer Use.app";
const CLIENT_RELATIVE_PATH = "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const COMPUTER_USE_CLIENT_PATH = path.join(os.userInfo().homedir, ".codex", COMPUTER_USE_APP_RELATIVE_PATH, CLIENT_RELATIVE_PATH);
const OPENAI_TEAM_ID = "2DC432GLL2";

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
	durationMs: number;
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
	/** Test-only working-directory process-enumerator override. */
	cwdEnumeratorCommand?: string;
	onSpawn?: (pid: number) => void;
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
	stdout?: string | Buffer;
	stderr?: string | Buffer;
}

type RunSync = (command: string, args: string[]) => CommandResult;

function productionRunSync(command: string, args: string[]): CommandResult {
	return spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
}

function verifySignedBinary(binaryPath: string, runSync: RunSync): void {
	const verify = runSync("/usr/bin/codesign", ["--verify", "--strict", binaryPath]);
	if (verify.status !== 0) throw new BrokerVerificationError(`Signature verification failed for ${path.basename(binaryPath)}`);
	const details = runSync("/usr/bin/codesign", ["-dv", "--verbose=2", binaryPath]);
	const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
	if (details.status !== 0 || !new RegExp(`(?:^|\\n)TeamIdentifier=${OPENAI_TEAM_ID}(?:\\n|$)`).test(output)) {
		throw new BrokerVerificationError(`${path.basename(binaryPath)} is not signed by the expected OpenAI team`);
	}
}

export interface OfficialComputerUseClient {
	clientPath: string;
	appPath: string;
	layout: "installed-component" | "legacy-plugin-bundle";
}

interface ResolveOfficialComputerUseClientOptions {
	/** Test-only OS-account home override. Production never reads HOME or CODEX_HOME. */
	userHome?: string;
	/** Test-only legacy root override. */
	legacyPluginRoot?: string;
	runSync?: RunSync;
}

function checkedCandidate(appPath: string, clientPath: string, layout: OfficialComputerUseClient["layout"], runSync: RunSync): OfficialComputerUseClient | undefined {
	if (!existsSync(clientPath)) return undefined;
	let canonicalApp: string;
	let canonicalClient: string;
	try {
		canonicalApp = realpathSync(appPath);
		canonicalClient = realpathSync(clientPath);
	} catch {
		throw new BrokerVerificationError("Could not resolve the official Computer Use client path");
	}
	if (canonicalApp !== path.resolve(appPath) || canonicalClient !== path.resolve(clientPath) || !canonicalClient.startsWith(`${canonicalApp}${path.sep}`)) {
		throw new BrokerVerificationError("Official Computer Use client path was not canonical");
	}
	verifySignedBinary(canonicalClient, runSync);
	return { appPath: canonicalApp, clientPath: canonicalClient, layout };
}

/** Resolve only the two reviewed official layouts, preferring ChatGPT's current installed-component contract. */
export function resolveOfficialComputerUseClient(options: ResolveOfficialComputerUseClientOptions = {}): OfficialComputerUseClient {
	const runSync = options.runSync ?? productionRunSync;
	const userHome = options.userHome ?? os.userInfo().homedir;
	const canonicalUserHome = existsSync(userHome) ? realpathSync(userHome) : path.resolve(userHome);
	const currentApp = path.join(canonicalUserHome, ".codex", COMPUTER_USE_APP_RELATIVE_PATH);
	const current = checkedCandidate(currentApp, path.join(currentApp, CLIENT_RELATIVE_PATH), "installed-component", runSync);
	if (current) return current;

	const legacyRoot = options.legacyPluginRoot ?? COMPUTER_USE_PLUGIN_ROOT;
	const canonicalLegacyRoot = existsSync(legacyRoot) ? realpathSync(legacyRoot) : path.resolve(legacyRoot);
	const legacyApp = path.join(canonicalLegacyRoot, "Codex Computer Use.app");
	const legacy = checkedCandidate(legacyApp, path.join(legacyApp, CLIENT_RELATIVE_PATH), "legacy-plugin-bundle", runSync);
	if (legacy) return legacy;
	throw new BrokerVerificationError("Official Computer Use client was not found in a supported location");
}

export function verifyOfficialDirectBroker(options: ResolveOfficialComputerUseClientOptions = {}) {
	const runSync = options.runSync ?? productionRunSync;
	verifySignedBinary(CODEX_PATH, runSync);
	const client = resolveOfficialComputerUseClient({ ...options, runSync });
	const version = runSync(CODEX_PATH, ["--version"]);
	if (version.status !== 0 || !/^codex-cli\s+\d+\./.test((version.stdout ?? "").toString().trim())) {
		throw new BrokerVerificationError("Could not verify the app-bundled Codex app-server version");
	}
	const build = runSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", path.join(client.appPath, "Contents", "Info.plist")]);
	const clientBuild = (build.stdout ?? "").toString().trim();
	if (build.status !== 0 || !clientBuild) {
		throw new BrokerVerificationError("Could not verify the official Computer Use client build");
	}
	return { brokerVersion: (version.stdout ?? "").toString().trim(), clientBuild, client };
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

export function buildDirectAppServerArgs(mcpCwd = COMPUTER_USE_PLUGIN_ROOT, clientPath = COMPUTER_USE_CLIENT_PATH): string[] {
	const mcpTable = `{"computer-use" = { command = ${JSON.stringify(clientPath)}, args = ["mcp"], cwd = ${JSON.stringify(mcpCwd)}, enabled = true, startup_timeout_sec = 30, tool_timeout_sec = 120 }}`;
	const disabledProvider = '{ name = "Direct dispatch disabled provider", base_url = "http://127.0.0.1:9/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_websockets = false, requires_openai_auth = false }';
	return [
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

function validateResult(value: JsonValue) {
	const result = directResultSchema.parse(value);
	return {
		content: result.content,
		structuredContent: result.structuredContent,
		isError: result.isError === true,
	};
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
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

function collectProcessesWithCwd(workDir: string, cwdEnumeratorCommand = "/usr/sbin/lsof"): Set<number> {
	const result = spawnSync(cwdEnumeratorCommand, ["-a", "-d", "cwd", "+d", workDir, "-Fp"], {
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
	cwdEnumeratorCommand = "/usr/sbin/lsof",
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
			for (const owned of collectProcessesWithCwd(workDir, cwdEnumeratorCommand)) found.add(owned);
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
		if (!processGroupExists(pid) && [...descendants].every((child) => !processExists(child))) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	let cwdSurvivors = new Set<number>();
	try { cwdSurvivors = collectProcessesWithCwd(workDir, cwdEnumeratorCommand); }
	catch (error) { cleanupError ??= error instanceof Error ? error : new Error(String(error)); }
	for (const survivor of cwdSurvivors) {
		try { process.kill(survivor, "SIGKILL"); } catch { /* exited */ }
	}
	if (processGroupExists(pid) || [...descendants, ...cwdSurvivors].some((child) => processExists(child))) {
		cleanupError ??= new Error("Official app-server process tree did not terminate");
	}
	if (cleanupError) throw cleanupError;
}

export interface OfficialDirectToolSession {
	call(
		method: DirectMethod,
		args: DirectToolArguments,
		options?: Pick<DirectBrokerOptions, "timeoutMs" | "signal" | "onElicitation" | "supportsOpenAiFormElicitation">,
	): Promise<DirectBrokerResult>;
	close(): Promise<void>;
}

export async function createOfficialDirectToolSession(
	options: DirectBrokerOptions = {},
): Promise<OfficialDirectToolSession> {
	const verification = options.skipSignatureVerification
		? { brokerVersion: "test-app-server", clientBuild: "test-client", client: undefined }
		: verifyOfficialDirectBroker();
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
		termination ??= terminateGroup(proc, workDir, options.processEnumeratorCommand, options.cwdEnumeratorCommand);
		return termination;
	};
	const fail = (error: Error): void => {
		fatalError ??= error;
		rejectAll(fatalError);
		void ensureTerminated().catch(() => undefined);
	};
	const send = (message: JsonValue): void => {
		if (!proc?.stdin.writable) throw new Error("Official app-server stdin is unavailable");
		proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
	};
	const request = (methodName: string, params: JsonValue, timeoutMs: number): Promise<JsonValue> => {
		const id = String(nextId++);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				const error = new Error(`Official app-server request timed out: ${methodName}`);
				reject(error);
				fail(error);
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try { send({ method: methodName, id, params }); }
			catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			closed = true;
			rejectAll(new Error("Official app-server closed"));
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
		const command = options.appServerCommand ?? CODEX_PATH;
		let commandArgs = options.appServerArgs;
		if (!commandArgs) {
			if (!verification.client) throw new BrokerVerificationError("The official Computer Use client was not verified");
			commandArgs = buildDirectAppServerArgs(workDir, verification.client.clientPath);
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
		proc.stderr.on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length); });
		proc.once("error", (error) => fail(error));
		proc.once("close", (code) => { if (!closed && pending.size > 0) fail(new Error(`Official app-server exited before completing the request (${code ?? "unknown"})`)); });

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
			if (fatalError) return;
			try {
				if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
					const waiter = pending.get(String(message.id));
					if (!waiter) return;
					pending.delete(String(message.id));
					clearTimeout(waiter.timer);
					if (message.error) waiter.reject(new Error(`Official app-server error: ${message.error.message ?? "unknown"}`));
					else waiter.resolve(message.result ?? null);
					return;
				}
				if (message.id != null && message.method) {
					if (message.method !== "mcpServer/elicitation/request") {
						send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
						return;
					}
					currentElicitationCount += 1;
					const parsedRequest = elicitationRequestSchema.safeParse(message.params ?? {});
					const requestParams = parsedRequest.success ? parsedRequest.data : {};
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
		const started = threadStartSchema.safeParse(await request("thread/start", {
			cwd: workDir, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true, serviceName: "pi_direct_computer_use",
		}, 30_000));
		if (!started.success) throw new BrokerVerificationError("App-server did not return a usable thread");
		threadId = started.data.thread.id;
		ephemeralThread = true;
	} catch (error) {
		const base = error instanceof Error ? error : new Error(String(error));
		const primary = /authentication|bearer|token/i.test(`${base.message}\n${stderr}`)
			? new Error("Official direct Computer Use broker reported an authentication failure") : base;
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
		async call(method, args, callOptions = {}) {
			if (closed) throw new DirectBrokerCallError("Official direct Computer Use session is closed", true);
			if (callActive) throw new DirectBrokerCallError("Official direct Computer Use session does not allow concurrent calls", false);
			callActive = true;
			currentElicitation = callOptions.onElicitation;
			currentElicitationCount = 0;
			const startedAt = Date.now();
			let directCalls = 0;
			let abortHandler: (() => void) | undefined;
			try {
				if (callOptions.signal) {
					abortHandler = () => fail(new Error("Direct Computer Use request cancelled"));
					if (callOptions.signal.aborted) abortHandler();
					else callOptions.signal.addEventListener("abort", abortHandler, { once: true });
				}
				if (fatalError) throw fatalError;
				const raw = await request("mcpServer/tool/call", { threadId, server: "computer-use", tool: method, arguments: args }, callOptions.timeoutMs ?? 120_000);
				directCalls = 1;
				if (modelTurnsStarted !== 0) throw new BrokerVerificationError("Model-turn activity was observed during direct dispatch");
				const result = validateResult(raw);
				return {
					...result,
					brokerVersion: verification.brokerVersion,
					clientBuild: verification.clientBuild,
					durationMs: Date.now() - startedAt,
					elicitationRequests: currentElicitationCount,
					modelTurnsStarted: 0,
					ephemeralThread: true,
					brokerCleanupVerified: false,
				};
			} catch (error) {
				const base = error instanceof Error ? error : new Error(String(error));
				const primary = /authentication|bearer|token/i.test(`${base.message}\n${stderr}`)
					? new Error("Official direct Computer Use broker reported an authentication failure") : base;
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
		close,
	};
}

export async function callOfficialDirectTool(
	method: DirectMethod,
	args: DirectToolArguments,
	options: DirectBrokerOptions = {},
): Promise<DirectBrokerResult> {
	let session: OfficialDirectToolSession | undefined;
	let result: DirectBrokerResult | undefined;
	let failure: unknown;
	try {
		session = await createOfficialDirectToolSession(options);
		result = await session.call(method, args, options);
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
		if (closeFailure.message !== "Official direct Computer Use broker cleanup failed") {
			throw new DirectBrokerCallError(closeFailure.message, true, closeFailure, failure instanceof DirectBrokerCallError ? failure : {});
		}
		throw new DirectBrokerCallError(closeFailure.message, false, closeFailure, failure instanceof DirectBrokerCallError ? failure : {});
	}
	if (failure) {
		if (failure instanceof DirectBrokerCallError) {
			throw new DirectBrokerCallError(failure.message, cleanupVerified, failure, failure);
		}
		throw failure;
	}
	if (!result) throw new DirectBrokerCallError("Official direct Computer Use ended without a result", cleanupVerified);
	return { ...result, brokerCleanupVerified: true };
}
