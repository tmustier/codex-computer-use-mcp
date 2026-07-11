import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MODEL, MODEL_REASONING, type ReasoningEffort } from "./policy.ts";
import { RESULT_SCHEMA } from "./prompt.ts";

const CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const COMPUTER_USE_PLUGIN_ROOT =
	"/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use";
const COMPUTER_USE_CLIENT_PATH = `${COMPUTER_USE_PLUGIN_ROOT}/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const OPENAI_TEAM_ID = "2DC432GLL2";

const DISABLED_PLUGINS = [
	"github@openai-curated",
	"google-drive@openai-curated",
	"documents@openai-primary-runtime",
	"spreadsheets@openai-primary-runtime",
	"presentations@openai-primary-runtime",
	"gmail@openai-curated",
	"google-calendar@openai-curated",
	"slack@openai-curated",
	"linear@openai-curated",
	"pdf@openai-primary-runtime",
	"template-creator@openai-primary-runtime",
	"visualize@openai-bundled",
	"chrome@openai-bundled",
	"browser@openai-bundled",
] as const;

export interface NativeResult {
	status: "ok" | "approval_required" | "blocked" | "error";
	app: string;
	mode: "list" | "inspect" | "act" | "dictionary_lookup";
	summary: string;
	cleaned: boolean;
	approvalRequired: boolean;
	usedCapabilities: string[];
	apps: Array<{ name: string; bundleId: string }>;
	message: string;
}

export interface Usage {
	input: number;
	cachedInput: number;
	output: number;
}

export type FirstPartyInterruption = "app_approval" | "sensitive_action" | "os_permission" | "unknown_elicitation";

export interface RunnerResult {
	exitCode: number;
	result?: NativeResult;
	usage: Usage;
	computerUseMethods: string[];
	approvalRequiredObserved: boolean;
	firstPartyInterruption?: FirstPartyInterruption;
	policyViolation?: string;
	errorKind?: string;
	errorSummary?: string;
	codexVersion: string;
	durationMs: number;
}

export interface RunnerOptions {
	allowedTools: string[];
	targetApp?: string;
	targetAppAliases?: string[];
	reasoningEffort?: ReasoningEffort;
	maxToolCalls?: number;
	validateCallArguments?: (tool: string, args: Record<string, unknown>) => string | undefined;
	timeoutMs?: number;
	signal?: AbortSignal;
	codexPath?: string;
	skipSignatureVerification?: boolean;
}

export class BrokerVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokerVerificationError";
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

export function verifyOfficialBroker(codexPath = CODEX_PATH): string {
	if (codexPath !== CODEX_PATH) throw new BrokerVerificationError("Only the app-bundled Codex path is permitted");
	verifySignedBinary(CODEX_PATH);
	verifySignedBinary(COMPUTER_USE_CLIENT_PATH);
	const version = spawnSync(CODEX_PATH, ["--version"], { encoding: "utf8", timeout: 5000 });
	if (version.status !== 0 || !/^codex-cli\s+\d+\./.test((version.stdout ?? "").trim())) {
		throw new BrokerVerificationError("Could not verify the app-bundled Codex version");
	}
	return (version.stdout ?? "").trim();
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function buildArgs(
	schemaPath: string,
	outputPath: string,
	workDir: string,
	allowedTools: string[],
	reasoningEffort: ReasoningEffort,
): string[] {
	if (allowedTools.length === 0) throw new Error("At least one Computer Use tool must be allowlisted");
	const config: string[] = [
		"features.shell_tool=false",
		"features.unified_exec=false",
		"features.multi_agent=false",
		"features.memories=false",
		"memories.use_memories=false",
		"memories.generate_memories=false",
		"features.shell_snapshot=false",
		"features.remote_plugin=false",
		"features.hooks=false",
		"analytics.enabled=false",
		'otel.exporter="none"',
		"otel.log_user_prompt=false",
		'web_search="disabled"',
		'history.persistence="none"',
		`model_reasoning_effort=${tomlString(reasoningEffort)}`,
		'model_verbosity="low"',
		"mcp_servers.computer-use.enabled=true",
		`mcp_servers.computer-use.command=${tomlString(COMPUTER_USE_CLIENT_PATH)}`,
		'mcp_servers.computer-use.args=["mcp"]',
		`mcp_servers.computer-use.cwd=${tomlString(COMPUTER_USE_PLUGIN_ROOT)}`,
		`mcp_servers.computer-use.enabled_tools=${JSON.stringify(allowedTools)}`,
		"apps._default.enabled=false",
		'plugins."computer-use@openai-bundled".enabled=true',
		...DISABLED_PLUGINS.map((plugin) => `plugins.${JSON.stringify(plugin)}.enabled=false`),
	];
	const args = ["-a", "never", "-s", "read-only", "-m", MODEL];
	for (const item of config) args.push("-c", item);
	args.push(
		"exec",
		"--strict-config",
		"--ignore-user-config",
		"--ephemeral",
		"--skip-git-repo-check",
		"--ignore-rules",
		"--json",
		"--color",
		"never",
		"--output-schema",
		schemaPath,
		"--output-last-message",
		outputPath,
		"-C",
		workDir,
		"-",
	);
	return args;
}

function eventItem(event: any): any {
	return event?.item && typeof event.item === "object" ? event.item : undefined;
}

function classifyFirstPartyInterruption(item: any): FirstPartyInterruption | undefined {
	if (!item || item.type !== "mcp_tool_call") return undefined;
	const failed = item.status === "failed" || item.isError === true || item.is_error === true || item.error != null;
	if (!failed) return undefined;
	let text = "";
	try {
		text = JSON.stringify(item.result ?? item.output ?? item.error ?? "").slice(0, 100_000).toLowerCase();
	} catch {
		return undefined;
	}
	if (/screen recording|accessibility permission|system privacy|privacy settings|\btcc\b/i.test(text)) return "os_permission";
	if (/sensitive.{0,80}(?:action|confirmation|approval)|(?:confirm|approve).{0,80}sensitive|disruptive.{0,80}(?:action|confirmation)/i.test(text)) {
		return "sensitive_action";
	}
	if (/(?:allow|approve).{0,80}(?:chatgpt|codex).{0,80}(?:use|access).{0,80}(?:app|application)|app.{0,80}(?:approval|access).{0,80}(?:required|denied|cancel)|not approved.{0,80}(?:app|application)/i.test(text)) {
		return "app_approval";
	}
	if (/(?:elicitation|approval|permission).{0,80}(?:cancel|denied|required|not approved|unavailable)/i.test(text)) {
		return "unknown_elicitation";
	}
	return undefined;
}

function parseToolArguments(item: any): Record<string, unknown> | undefined {
	const raw = item?.arguments ?? item?.args ?? item?.input;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw !== "string") return undefined;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function inspectExecEvent(
	event: any,
	allowedTools: readonly string[],
	targetApp?: string,
	targetAppAliases: readonly string[] = [],
): { violation?: string; methods: string[] } {
	const item = eventItem(event);
	if (!item) return { methods: [] };
	const type = String(item.type ?? "");
	if (["command_execution", "file_change", "web_search", "image_view", "browser_action"].includes(type)) {
		return { violation: `Codex attempted forbidden tool item type: ${type}`, methods: [] };
	}
	if (type !== "mcp_tool_call") return { methods: [] };
	const server = String(item.server ?? item.server_name ?? item.mcp_server ?? "");
	const tool = String(item.tool ?? item.tool_name ?? item.name ?? "");
	if (server !== "computer-use" && server !== "computer_use") {
		return { violation: `Codex attempted a non-computer-use MCP server: ${server || "unknown"}`, methods: [] };
	}
	if (!allowedTools.includes(tool)) {
		return { violation: `Codex attempted a Computer Use tool outside the per-operation allowlist: ${tool || "unknown"}`, methods: [] };
	}
	if (tool !== "list_apps" && targetApp) {
		const args = parseToolArguments(item);
		const confirmedTargets = new Set([targetApp, ...targetAppAliases].map((value) => value.trim().toLowerCase()));
		if (!args || typeof args.app !== "string" || !confirmedTargets.has(args.app.trim().toLowerCase())) {
			return { violation: "Codex attempted Computer Use against an app outside the confirmed target lease", methods: [] };
		}
	}
	return { methods: [tool] };
}

function normalizeUsage(event: any, usage: Usage): void {
	if (event?.type !== "turn.completed" || !event.usage) return;
	const source = event.usage;
	usage.input = Number(source.input_tokens ?? source.input ?? usage.input) || 0;
	usage.cachedInput = Number(source.cached_input_tokens ?? source.cached_input ?? source.cache_read ?? usage.cachedInput) || 0;
	usage.output = Number(source.output_tokens ?? source.output ?? usage.output) || 0;
}

function safeErrorSummary(value: string): string | undefined {
	const first = value.split("\n").map((line) => line.trim()).find(Boolean);
	if (!first) return undefined;
	return first
		.replace(/\/Users\/[^/\s]+/g, "~")
		.replace(/https?:\/\/\S+/g, "[url]")
		.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
		.slice(0, 256);
}

function buildWorkerEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: os.homedir(),
		CODEX_HOME: path.join(os.homedir(), ".codex"),
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		NO_COLOR: "1",
		CLICOLOR: "0",
	};
	for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

function classifyFailure(stderr: string, exitCode: number): string {
	const value = stderr.toLowerCase();
	if (value.includes("rate limit") || value.includes("usage limit")) return "rate_limit";
	if (value.includes("requires a newer version")) return "version_mismatch";
	if (value.includes("not logged in") || value.includes("authentication")) return "authentication";
	if (value.includes("strict config") || value.includes("configuration")) return "configuration";
	if (exitCode === 124) return "timeout";
	return "broker_failed";
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

async function terminateGroup(pid: number | undefined): Promise<void> {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
	}
	for (let elapsed = 0; elapsed < 1000; elapsed += 50) {
		if (!processGroupExists(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!processGroupExists(pid)) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already exited
		}
	}
}

function isNativeResult(value: any): value is NativeResult {
	return (
		value &&
		typeof value === "object" &&
		["ok", "approval_required", "blocked", "error"].includes(value.status) &&
		typeof value.app === "string" &&
		value.app.length <= 500 &&
		["list", "inspect", "act", "dictionary_lookup"].includes(value.mode) &&
		typeof value.summary === "string" &&
		value.summary.length <= 1000 &&
		typeof value.cleaned === "boolean" &&
		typeof value.approvalRequired === "boolean" &&
		Array.isArray(value.usedCapabilities) &&
		value.usedCapabilities.length <= 50 &&
		value.usedCapabilities.every((item: unknown) => typeof item === "string") &&
		Array.isArray(value.apps) &&
		value.apps.length <= 100 &&
		value.apps.every(
			(item: unknown) =>
				item !== null &&
				typeof item === "object" &&
				typeof (item as any).name === "string" &&
				(item as any).name.length <= 120 &&
				typeof (item as any).bundleId === "string" &&
				(item as any).bundleId.length <= 160,
		) &&
		typeof value.message === "string" &&
		value.message.length <= 256
	);
}

export async function runOfficialCodex(prompt: string, options: RunnerOptions): Promise<RunnerResult> {
	const started = Date.now();
	const codexPath = options.codexPath ?? CODEX_PATH;
	const codexVersion = options.skipSignatureVerification ? "test-codex" : verifyOfficialBroker(codexPath);
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-native-app-worker."));
	const schemaPath = path.join(tempRoot, "result-schema.json");
	const outputPath = path.join(tempRoot, "last-message.json");
	const usage: Usage = { input: 0, cachedInput: 0, output: 0 };
	const methods: string[] = [];
	let startedCallCount = 0;
	let completedCallCount = 0;
	let approvalRequiredObserved = false;
	let firstPartyInterruption: FirstPartyInterruption | undefined;
	let policyViolation: string | undefined;
	let stderr = "";
	let observedErrorText = "";
	let timedOut = false;
	let aborted = false;
	let proc: ReturnType<typeof spawn> | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;
	let terminationPromise: Promise<void> | undefined;
	const requestTermination = (): Promise<void> => {
		terminationPromise ??= terminateGroup(proc?.pid);
		return terminationPromise;
	};

	try {
		await mkdir(path.join(tempRoot, "work"), { mode: 0o700 });
		await writeFile(schemaPath, `${JSON.stringify(RESULT_SCHEMA)}\n`, { mode: 0o600 });
		const args = buildArgs(
			schemaPath,
			outputPath,
			path.join(tempRoot, "work"),
			options.allowedTools,
			options.reasoningEffort ?? MODEL_REASONING,
		);
		proc = spawn(codexPath, args, {
			cwd: path.join(tempRoot, "work"),
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: buildWorkerEnv(),
		});
		let stdoutBuffer = "";
		const processEventLine = (line: string): void => {
			if (!line.trim() || policyViolation) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				policyViolation = "Codex emitted malformed JSON events";
				void requestTermination();
				return;
			}
			normalizeUsage(event, usage);
			if ((event.type === "error" || event.type === "turn.failed") && observedErrorText.length < 4096) {
				const candidate = typeof event.message === "string" ? event.message : JSON.stringify(event.error ?? "");
				observedErrorText += candidate.slice(0, 4096 - observedErrorText.length);
			}
			if (event.type !== "item.started" && event.type !== "item.completed") return;
			const rawArgs = event.item?.arguments ?? event.item?.args ?? event.item?.input;
			const targetForInspection = event.type === "item.completed" || rawArgs !== undefined ? options.targetApp : undefined;
			const inspection = inspectExecEvent(event, options.allowedTools, targetForInspection, options.targetAppAliases);
			if (inspection.violation) {
				policyViolation = inspection.violation;
				void requestTermination();
				return;
			}
			if (inspection.methods.length > 0) {
				if (event.type === "item.started") startedCallCount += inspection.methods.length;
				else completedCallCount += inspection.methods.length;
				const attemptedCalls = Math.max(startedCallCount, completedCallCount);
				if (attemptedCalls > (options.maxToolCalls ?? 100)) {
					policyViolation = `Computer Use call budget exceeded in stream (${attemptedCalls}/${options.maxToolCalls ?? 100})`;
					void requestTermination();
					return;
				}
			}
			if (event.type !== "item.completed") return;
			const interruption = classifyFirstPartyInterruption(event.item);
			if (interruption) {
				firstPartyInterruption ??= interruption;
				if (interruption === "app_approval") approvalRequiredObserved = true;
			}
			const status = String(event.item?.status ?? "").toLowerCase();
			const successful =
				["completed", "success", "succeeded", "ok"].includes(status) &&
				event.item?.isError !== true &&
				event.item?.is_error !== true &&
				event.item?.error == null;
			const failed = !successful;
			if (!failed && options.validateCallArguments && inspection.methods.length > 0) {
				const args = parseToolArguments(event.item);
				const method = inspection.methods[0];
				const argumentViolation =
					!args || !method
						? "Could not validate successful Computer Use call arguments"
						: options.validateCallArguments(method, args);
				if (argumentViolation) {
					policyViolation = argumentViolation;
					void requestTermination();
					return;
				}
			}
			if (!failed) methods.push(...inspection.methods);
		};
		proc.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE" && (aborted || timedOut || policyViolation !== undefined)) return;
			if (stderr.length < 16_384) stderr += String(error.message).slice(0, 16_384 - stderr.length);
		});
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			if (stdoutBuffer.length > 8_000_000) {
				policyViolation = "Codex JSON event line exceeded the 8MB safety bound";
				void requestTermination();
				return;
			}
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processEventLine(line);
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
		});

		const timeoutMs = options.timeoutMs ?? 240_000;
		timeout = setTimeout(() => {
			timedOut = true;
			void requestTermination();
		}, timeoutMs);
		if (options.signal) {
			abortHandler = () => {
				aborted = true;
				void requestTermination();
			};
			if (options.signal.aborted) abortHandler();
			else options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		if (aborted) proc.stdin?.destroy();
		else proc.stdin?.end(prompt, "utf8");
		const exitCode = await new Promise<number>((resolve) => {
			proc!.once("error", () => resolve(1));
			proc!.once("close", (code) => resolve(code ?? 1));
		});
		if (stdoutBuffer.trim()) processEventLine(stdoutBuffer);
		stdoutBuffer = "";
		if (timeout) clearTimeout(timeout);
		if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
		if (terminationPromise) await terminationPromise;

		let result: NativeResult | undefined;
		if (!policyViolation && !timedOut && exitCode === 0) {
			try {
				const parsed = JSON.parse(await readFile(outputPath, "utf8"));
				if (isNativeResult(parsed)) result = parsed;
				else policyViolation = "Codex final response did not match the constrained result schema";
			} catch {
				policyViolation = "Codex did not produce a parseable constrained result";
			}
		}
		const failureText = `${stderr}\n${observedErrorText}`;
		return {
			exitCode: aborted ? 130 : timedOut ? 124 : exitCode,
			result,
			usage,
			computerUseMethods: methods,
			approvalRequiredObserved,
			firstPartyInterruption,
			policyViolation,
			errorKind: policyViolation
				? "policy_violation"
				: aborted
					? "cancelled"
					: timedOut
						? "timeout"
						: exitCode === 0
						? undefined
						: classifyFailure(failureText, exitCode),
			errorSummary: aborted ? "Computer Use request cancelled" : exitCode === 0 ? undefined : safeErrorSummary(failureText),
			codexVersion,
			durationMs: Date.now() - started,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
		if (proc?.pid && proc.exitCode === null) await requestTermination();
		if (terminationPromise) await terminationPromise;
		await rm(tempRoot, { recursive: true, force: true });
	}
}
