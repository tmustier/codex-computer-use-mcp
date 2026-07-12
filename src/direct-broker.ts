import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./config.ts";
import {
	EXPECTED_OFFICIAL_INPUT_SCHEMAS,
	OFFICIAL_METHODS,
	type DirectMethod,
	type DirectToolArguments,
} from "./tools.ts";

export const CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
export const COMPUTER_USE_PLUGIN_ROOT =
	"/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use";
export const COMPUTER_USE_CLIENT_PATH = `${COMPUTER_USE_PLUGIN_ROOT}/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const OPENAI_TEAM_ID = "2DC432GLL2";
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 25 * 1024 * 1024;

export interface DirectBrokerResult {
	content: Array<Record<string, unknown>>;
	structuredContent?: unknown;
	isError: boolean;
	brokerVersion: string;
	clientBuild: string;
	durationMs: number;
	approvalRequests: number;
	modelTurnsStarted: 0;
	ephemeralThread: true;
	brokerCleanupVerified: true;
}

export interface DirectBrokerOptions {
	permissionMode: PermissionMode;
	timeoutMs?: number;
	signal?: AbortSignal;
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

export class BrokerVerificationError extends Error {
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
	readonly approvalRequests: number;
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
			approvalRequests?: number;
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
		this.approvalRequests = evidence.approvalRequests ?? 0;
		this.brokerVersion = evidence.brokerVersion ?? "unknown";
		this.clientBuild = evidence.clientBuild ?? "unknown";
	}
}

function verifySignedBinary(binaryPath: string): void {
	const verify = spawnSync("/usr/bin/codesign", ["--verify", "--strict", binaryPath], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (verify.status !== 0) throw new BrokerVerificationError(`Signature verification failed for ${path.basename(binaryPath)}`);
	const details = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", binaryPath], {
		encoding: "utf8",
		timeout: 10_000,
	});
	const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
	if (details.status !== 0 || !output.includes(`TeamIdentifier=${OPENAI_TEAM_ID}`)) {
		throw new BrokerVerificationError(`${path.basename(binaryPath)} is not signed by the expected OpenAI team`);
	}
}

function clientBuild(): string {
	const plist = path.join(
		COMPUTER_USE_PLUGIN_ROOT,
		"Codex Computer Use.app",
		"Contents",
		"Info.plist",
	);
	const result = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", plist], {
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.status !== 0 || !(result.stdout ?? "").trim()) {
		throw new BrokerVerificationError("Could not verify the official Computer Use client build");
	}
	return (result.stdout ?? "").trim();
}

export function verifyOfficialDirectBroker(): { brokerVersion: string; clientBuild: string } {
	verifySignedBinary(CODEX_PATH);
	verifySignedBinary(COMPUTER_USE_CLIENT_PATH);
	const version = spawnSync(CODEX_PATH, ["--version"], { encoding: "utf8", timeout: 5000 });
	if (version.status !== 0 || !/^codex-cli\s+\d+\./.test((version.stdout ?? "").trim())) {
		throw new BrokerVerificationError("Could not verify the app-bundled Codex app-server version");
	}
	return { brokerVersion: (version.stdout ?? "").trim(), clientBuild: clientBuild() };
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

export function buildDirectAppServerArgs(mcpCwd = COMPUTER_USE_PLUGIN_ROOT): string[] {
	const mcpTable = `{"computer-use" = { command = ${JSON.stringify(COMPUTER_USE_CLIENT_PATH)}, args = ["mcp"], cwd = ${JSON.stringify(mcpCwd)}, enabled = true, startup_timeout_sec = 30, tool_timeout_sec = 120 }}`;
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

function normalizeSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeSchema).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, normalizeSchema(child)]),
		);
	}
	return value;
}

function schemasEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(normalizeSchema(left)) === JSON.stringify(normalizeSchema(right));
}

function validateInventory(result: unknown): void {
	const data = (result as any)?.data;
	if (!Array.isArray(data)) throw new BrokerVerificationError("App-server returned an invalid MCP inventory");
	const server = data.find((entry: any) => entry?.name === "computer-use");
	if (!server || !server.tools || typeof server.tools !== "object") {
		throw new BrokerVerificationError("Official computer-use MCP server was not available");
	}
	const names = Object.keys(server.tools).sort();
	const expectedNames = [...OFFICIAL_METHODS].sort();
	if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
		throw new BrokerVerificationError("Official Computer Use tool inventory drifted; refusing direct dispatch");
	}
	for (const method of OFFICIAL_METHODS) {
		const upstream = server.tools[method];
		const schema = upstream?.inputSchema ?? upstream?.input_schema;
		if (!schemasEqual(schema, EXPECTED_OFFICIAL_INPUT_SCHEMAS[method])) {
			throw new BrokerVerificationError(`Official Computer Use schema drifted for ${method}; refusing direct dispatch`);
		}
	}
}

function validateResult(value: unknown): {
	content: Array<Record<string, unknown>>;
	structuredContent?: unknown;
	isError: boolean;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Official Computer Use returned an invalid result");
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.content) || record.content.length > 100) throw new Error("Official Computer Use returned invalid content blocks");
	const content = record.content as Array<Record<string, unknown>>;
	for (const item of content) {
		if (!item || typeof item !== "object" || Array.isArray(item) || (item.type !== "text" && item.type !== "image")) {
			throw new Error("Official Computer Use returned an unsupported content block");
		}
		if (item.type === "text" && typeof item.text !== "string") throw new Error("Official Computer Use returned malformed text content");
		if (item.type === "image" && (typeof item.data !== "string" || typeof item.mimeType !== "string")) {
			throw new Error("Official Computer Use returned malformed image content");
		}
	}
	let encodedBytes = 0;
	try {
		encodedBytes = Buffer.byteLength(JSON.stringify({ content, structuredContent: record.structuredContent }), "utf8");
	} catch {
		throw new Error("Official Computer Use returned unserializable content");
	}
	if (encodedBytes > MAX_RESULT_BYTES) throw new Error("Official Computer Use result exceeded the 25MB safety bound");
	return {
		content,
		...(record.structuredContent !== undefined ? { structuredContent: record.structuredContent } : {}),
		isError: record.isError === true,
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

export async function callOfficialDirectTool(
	method: DirectMethod,
	args: DirectToolArguments,
	options: DirectBrokerOptions,
): Promise<DirectBrokerResult> {
	const startedAt = Date.now();
	const verification = options.skipSignatureVerification
		? { brokerVersion: "test-app-server", clientBuild: "test-client" }
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
	let abortHandler: (() => void) | undefined;
	let fatalError: Error | undefined;
	let stderr = "";
	let nextId = 1;
	let approvalRequests = 0;
	let modelTurnsStarted = 0;
	let directCalls = 0;
	let ephemeralThread = false;
	let finalResult: DirectBrokerResult | undefined;
	let primaryError: Error | undefined;
	let cleanupVerified = false;
	const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
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
	const send = (message: unknown): void => {
		if (!proc?.stdin.writable) throw new Error("Official app-server stdin is unavailable");
		proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
	};
	const request = (methodName: string, params: unknown, timeoutMs: number): Promise<unknown> => {
		const id = String(nextId++);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Official app-server request timed out: ${methodName}`));
				void ensureTerminated().catch(() => undefined);
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try {
				send({ method: methodName, id, params });
			} catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	try {
		const command = options.appServerCommand ?? CODEX_PATH;
		const commandArgs = options.appServerArgs ?? buildDirectAppServerArgs(workDir);
		proc = spawn(command, commandArgs, {
			cwd: workDir,
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: buildBrokerEnv(codexHome, tempRoot),
		});
		processClosed = new Promise((resolve) => proc!.once("close", () => resolve()));
		if (proc.pid) options.onSpawn?.(proc.pid);
		proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") fail(error);
		});
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
		});
		proc.once("error", (error) => fail(error));
		proc.once("close", (code) => {
			if (pending.size > 0) fail(new Error(`Official app-server exited before completing the request (${code ?? "unknown"})`));
		});

		const processProtocolLine = (line: string): void => {
			let message: any;
			try { message = JSON.parse(line); } catch {
				fail(new Error("Official app-server emitted malformed JSONL"));
				return;
			}
			if (typeof message?.method === "string" && (message.method.startsWith("turn/") || message.method.startsWith("item/"))) {
				modelTurnsStarted += 1;
				fail(new Error("Official app-server unexpectedly emitted model-turn activity during direct dispatch"));
				return;
			}
			if (fatalError) return;
			try {
				if (message?.id != null && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
					const waiter = pending.get(String(message.id));
					if (!waiter) return;
					pending.delete(String(message.id));
					clearTimeout(waiter.timer);
					if (message.error) waiter.reject(new Error(`Official app-server error: ${String(message.error.message ?? "unknown")}`));
					else waiter.resolve(message.result);
					return;
				}
				if (message?.id != null && typeof message.method === "string") {
					if (message.method !== "mcpServer/elicitation/request") {
						send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
						return;
					}
					if (approvalRequests >= 8) {
						fail(new Error("Official app-server emitted excessive elicitation requests"));
						return;
					}
					approvalRequests += 1;
					// Durable configuration is the sole permission authority. Full permissions
					// deterministically authorizes first-party app access with no model/UI vote;
					// safe mode deterministically declines it.
					const result = options.permissionMode === "full-permissions"
						? { action: "accept", content: {}, _meta: { persist: "always" } }
						: { action: "decline" };
					send({ id: message.id, result });
					return;
				}
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};
		let stdoutBuffer = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			let offset = 0;
			while (offset < chunk.length) {
				const newline = chunk.indexOf("\n", offset);
				const end = newline === -1 ? chunk.length : newline;
				const segment = chunk.slice(offset, end);
				if (Buffer.byteLength(stdoutBuffer, "utf8") + Buffer.byteLength(segment, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
					fail(new Error("Official app-server protocol line exceeded the 8MB safety bound"));
					return;
				}
				if (newline === -1) {
					stdoutBuffer += segment;
					return;
				}
				const line = stdoutBuffer + segment;
				stdoutBuffer = "";
				if (line.length > 0) processProtocolLine(line);
				offset = newline + 1;
			}
		});
		proc.stdout.on("end", () => {
			if (stdoutBuffer.length > 0) processProtocolLine(stdoutBuffer);
			stdoutBuffer = "";
		});

		if (options.signal) {
			abortHandler = () => {
				fail(new Error("Direct Computer Use request cancelled"));
			};
			if (options.signal.aborted) abortHandler();
			else options.signal.addEventListener("abort", abortHandler, { once: true });
		}
		if (fatalError) throw fatalError;
		await request(
			"initialize",
			{
				clientInfo: { name: "pi_direct_computer_use", title: "Pi Direct Computer Use", version: "0.2.0" },
				capabilities: { mcpServerOpenaiFormElicitation: true },
			},
			15_000,
		);
		send({ method: "initialized" });
		const started = (await request(
			"thread/start",
			{
				cwd: workDir,
				// `never` makes Codex auto-deny MCP elicitations before they reach this
				// client. Full mode uses `on-request` only as a relay; the durable config
				// still makes the deterministic accept decision above without a model/UI.
				approvalPolicy: options.permissionMode === "full-permissions" ? "on-request" : "never",
				sandbox: "read-only",
				ephemeral: true,
				serviceName: "pi_direct_computer_use",
			},
			30_000,
		)) as any;
		const thread = started?.thread;
		const threadId = thread?.id;
		if (
			typeof threadId !== "string"
			|| thread.ephemeral !== true
			|| !Object.prototype.hasOwnProperty.call(thread, "path")
			|| thread.path !== null
			|| !Array.isArray(thread.turns)
			|| thread.turns.length !== 0
		) {
			throw new BrokerVerificationError("App-server did not attest an empty pathless ephemeral runtime context");
		}
		ephemeralThread = true;
		const inventory = await request(
			"mcpServerStatus/list",
			{ threadId, detail: "toolsAndAuthOnly" },
			45_000,
		);
		validateInventory(inventory);
		const raw = await request(
			"mcpServer/tool/call",
			{ threadId, server: "computer-use", tool: method, arguments: args },
			options.timeoutMs ?? 120_000,
		);
		directCalls = 1;
		if (modelTurnsStarted !== 0) throw new BrokerVerificationError("Model-turn activity was observed during direct dispatch");
		const result = validateResult(raw);
		finalResult = {
			...result,
			brokerVersion: verification.brokerVersion,
			clientBuild: verification.clientBuild,
			durationMs: Date.now() - startedAt,
			approvalRequests,
			modelTurnsStarted: 0,
			ephemeralThread: true,
			brokerCleanupVerified: true,
		};
	} catch (error) {
		const base = error instanceof Error ? error : new Error(String(error));
		primaryError = /authentication|bearer|token/i.test(`${base.message}\n${stderr}`)
			? new Error("Official direct Computer Use broker reported an authentication failure")
			: base;
	} finally {
		if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
		rejectAll(new Error("Official app-server closed"));
		try {
			await ensureTerminated();
			if (processClosed) {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("Official app-server stdio did not close")), 1_000);
					processClosed!.then(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (fatalError || modelTurnsStarted !== 0) {
				primaryError = fatalError ?? new BrokerVerificationError("Model-turn activity was observed during broker teardown");
			}
			await rm(tempRoot, { recursive: true, force: true });
			cleanupVerified = true;
		} catch (cleanupError) {
			primaryError = new Error("Official direct Computer Use broker cleanup failed", { cause: cleanupError });
		}
	}
	const failureEvidence = {
		directCalls,
		modelTurnsStarted,
		ephemeralThread,
		approvalRequests,
		brokerVersion: verification.brokerVersion,
		clientBuild: verification.clientBuild,
	};
	if (primaryError) throw new DirectBrokerCallError(primaryError.message, cleanupVerified, primaryError, failureEvidence);
	if (!finalResult) throw new DirectBrokerCallError("Official direct Computer Use ended without a result", cleanupVerified, undefined, failureEvidence);
	return finalResult;
}
