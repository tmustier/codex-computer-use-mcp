import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

export interface ElicitationRequest {
	mode?: string;
	message?: string;
	requestedSchema?: unknown;
	serverName?: string;
}

export interface ElicitationResponse {
	action: "accept" | "decline" | "cancel";
	content?: unknown;
	_meta?: unknown;
}

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
	timeoutMs?: number;
	signal?: AbortSignal;
	onElicitation?: (request: ElicitationRequest) => Promise<ElicitationResponse>;
	/** Test-only executable override. Production callers never set this. */
	appServerCommand?: string;
	/** Test-only argument override. */
	appServerArgs?: string[];
	/** Test-only signature bypass. */
	skipSignatureVerification?: boolean;
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
	constructor(message: string, cleanupVerified: boolean, cause?: unknown) {
		super(message, { cause });
		this.name = "DirectBrokerCallError";
		this.cleanupVerified = cleanupVerified;
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

function buildBrokerEnv(codexHome: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: os.homedir(),
		CODEX_HOME: codexHome,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		NO_COLOR: "1",
		CLICOLOR: "0",
	};
	for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

export function buildDirectAppServerArgs(): string[] {
	const mcpTable = `{"computer-use" = { command = ${JSON.stringify(COMPUTER_USE_CLIENT_PATH)}, args = ["mcp"], cwd = ${JSON.stringify(COMPUTER_USE_PLUGIN_ROOT)}, enabled = true, startup_timeout_sec = 30, tool_timeout_sec = 120 }}`;
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

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

async function terminateGroup(proc: ChildProcessWithoutNullStreams | undefined): Promise<void> {
	const pid = proc?.pid;
	if (!pid) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try { proc.kill("SIGTERM"); } catch { return; }
	}
	for (let elapsed = 0; elapsed < 1000; elapsed += 50) {
		if (!processGroupExists(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* exited */ } }
	for (let elapsed = 0; elapsed < 500; elapsed += 25) {
		if (!processGroupExists(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (processGroupExists(pid)) throw new Error("Official app-server process group did not terminate");
}

export async function callOfficialDirectTool(
	method: DirectMethod,
	args: DirectToolArguments,
	options: DirectBrokerOptions = {},
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
	let abortHandler: (() => void) | undefined;
	let fatalError: Error | undefined;
	let stderr = "";
	let nextId = 1;
	let approvalRequests = 0;
	let modelTurnsStarted = 0;
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
	const fail = (error: Error): void => {
		fatalError ??= error;
		rejectAll(fatalError);
		void terminateGroup(proc);
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
				void terminateGroup(proc);
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try { send({ method: methodName, id, params }); } catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	try {
		const command = options.appServerCommand ?? CODEX_PATH;
		const commandArgs = options.appServerArgs ?? buildDirectAppServerArgs();
		proc = spawn(command, commandArgs, {
			cwd: workDir,
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: buildBrokerEnv(codexHome),
		});
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

		const lines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", (line) => {
			if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
				fail(new Error("Official app-server protocol line exceeded the 8MB safety bound"));
				return;
			}
			let message: any;
			try { message = JSON.parse(line); } catch {
				fail(new Error("Official app-server emitted malformed JSONL"));
				return;
			}
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
				approvalRequests += 1;
				void (async () => {
					let response: ElicitationResponse = { action: "decline" };
					if (options.onElicitation) {
						try { response = await options.onElicitation(message.params as ElicitationRequest); }
						catch { response = { action: "cancel" }; }
					}
					send({ id: message.id, result: response });
				})();
				return;
			}
			if (typeof message?.method === "string" && (message.method.startsWith("turn/") || message.method.startsWith("item/"))) {
				modelTurnsStarted += 1;
				fail(new Error("Official app-server unexpectedly emitted model-turn activity during direct dispatch"));
			}
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
				capabilities: { mcpServerOpenaiFormElicitation: options.onElicitation !== undefined },
			},
			15_000,
		);
		send({ method: "initialized" });
		const started = (await request(
			"thread/start",
			{ cwd: workDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, serviceName: "pi_direct_computer_use" },
			30_000,
		)) as any;
		const threadId = started?.thread?.id;
		if (typeof threadId !== "string" || started.thread.path != null || (started.thread.turns?.length ?? 0) !== 0) {
			throw new BrokerVerificationError("App-server did not create an empty ephemeral runtime context");
		}
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
			await terminateGroup(proc);
			await rm(tempRoot, { recursive: true, force: true });
			cleanupVerified = true;
		} catch (cleanupError) {
			primaryError = new Error("Official direct Computer Use broker cleanup failed", { cause: cleanupError });
		}
	}
	if (primaryError) throw new DirectBrokerCallError(primaryError.message, cleanupVerified, primaryError);
	if (!finalResult) throw new DirectBrokerCallError("Official direct Computer Use ended without a result", cleanupVerified);
	return finalResult;
}
