import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import {
	callOfficialCuaRepl,
	DirectBrokerCallError,
	pathConfigFile,
	readOfficialCuaReplServer,
	UnifiedRuntimeUnavailableError,
	verifyOfficialDirectBroker,
	type DirectBrokerElicitationRequest,
	type DirectBrokerElicitationResponse,
	type DirectBrokerResult,
} from "./direct-broker.ts";
import {
	CUA_REPL_TOOLS,
	cuaReplToolDefinitions,
	type CuaReplTool,
	type CuaReplToolSet,
	type JsonObject,
	type JsonValue,
} from "./tools.ts";
import { getDirectStatus as getLegacyStatus } from "./legacy/direct-service.ts";

const requestSchema = z.object({
	tool: z.enum(CUA_REPL_TOOLS),
	arguments: z.record(z.string(), z.json()).default({}),
});

export interface DirectResponse {
	isError: boolean;
	content: JsonObject[];
	structuredContent?: JsonValue;
}

export interface DirectServiceDependencies {
	stateRoot?: string;
	signal?: AbortSignal;
	onElicitation?: (
		request: DirectBrokerElicitationRequest,
	) => DirectBrokerElicitationResponse | Promise<DirectBrokerElicitationResponse>;
	supportsOpenAiFormElicitation?: boolean;
	callTool?: typeof callOfficialCuaRepl;
}

export function defaultStateRoot(): string {
	return process.env.CODEX_COMPUTER_USE_HOME || path.join(homedir(), ".direct-computer-use");
}

function inputByteCount(value: JsonValue): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function executeDirectTool(raw: JsonValue, deps: DirectServiceDependencies = {}): Promise<DirectResponse> {
	const stateRoot = deps.stateRoot ?? defaultStateRoot();
	const runId = crypto.randomUUID();
	const startedAt = Date.now();
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) {
		await appendAudit(stateRoot, {
			timestamp: new Date().toISOString(),
			runId,
			method: "invalid_request",
			inputBytes: inputByteCount(raw),
			outcome: "input_rejected",
			durationMs: Date.now() - startedAt,
			brokerVersion: null,
			clientBuild: null,
			directCalls: 0,
			modelTurnsStarted: 0,
			ephemeralThread: null,
			elicitationRequests: 0,
			brokerCleanupVerified: true,
			resultContentTypes: [],
			resultBytes: 0,
		});
		throw new Error("Direct Computer Use request did not name a cua_repl tool");
	}
	const { tool, arguments: args } = parsed.data;
	const timeout = z.number().safeParse(args.timeout_ms);
	const executionMs = tool === "js" && timeout.success ? timeout.data : 30_000;
	let result: { ok: true; broker: DirectBrokerResult } | { ok: false; error: Error };
	try {
		const broker = await (deps.callTool ?? callOfficialCuaRepl)(tool, args, {
			signal: deps.signal,
			// Leave room beyond node_repl's execution timeout, with the existing two-minute floor.
			timeoutMs: Math.max(120_000, executionMs + 30_000),
			onElicitation: deps.onElicitation,
			supportsOpenAiFormElicitation: deps.supportsOpenAiFormElicitation,
			configPath: pathConfigFile(stateRoot),
		});
		result = { ok: true, broker };
	} catch (error) {
		result = { ok: false, error: error instanceof Error ? error : new Error("Direct Computer Use failed") };
	}

	const brokerFailure = !result.ok && result.error instanceof DirectBrokerCallError ? result.error : undefined;
	const evidence = result.ok ? result.broker : brokerFailure;
	const content = result.ok ? result.broker.content : [];

	await appendAudit(stateRoot, {
		timestamp: new Date().toISOString(),
		runId,
		method: tool,
		inputBytes: inputByteCount(args),
		outcome: result.ok
			? result.broker.isError ? "official_error" : "ok"
			: deps.signal?.aborted ? "cancelled" : "broker_failed",
		durationMs: Date.now() - startedAt,
		brokerVersion: evidence?.brokerVersion ?? null,
		clientBuild: evidence?.clientBuild ?? null,
		directCalls: result.ok ? 1 : brokerFailure?.directCalls ?? 0,
		modelTurnsStarted: evidence?.modelTurnsStarted ?? 0,
		ephemeralThread: evidence?.ephemeralThread ?? null,
		elicitationRequests: evidence?.elicitationRequests ?? 0,
		brokerCleanupVerified: result.ok ? result.broker.brokerCleanupVerified : brokerFailure?.cleanupVerified ?? false,
		resultContentTypes: [...new Set(content.map((item) => String(item.type ?? "unknown")))].sort(),
		resultBytes: result.ok ? Buffer.byteLength(JSON.stringify(content), "utf8") : 0,
	});
	if (!result.ok) throw result.error;
	const { isError, structuredContent } = result.broker;
	return { isError, content, structuredContent };
}

type DirectStatus = {
	stateRoot: string;
	permissionMode: "no-permissions";
	configPath: string;
	tools: CuaReplTool[];
} & (
	| { brokerVerified: true; brokerVersion: string; clientBuild: string; codexPath: string; nodeReplPath: string; cuaReplConfigPath: string }
	| { brokerVerified: false; brokerError: string }
);

export function getDirectStatus(stateRoot = defaultStateRoot()): DirectStatus {
	const status = {
		stateRoot,
		configPath: pathConfigFile(stateRoot),
		permissionMode: "no-permissions" as const,
		tools: [...CUA_REPL_TOOLS],
	};
	try {
		const { codexPath, brokerVersion, clientBuild, cuaRepl } = verifyOfficialDirectBroker({ configPath: status.configPath });
		return { ...status, brokerVerified: true, codexPath, brokerVersion, clientBuild, nodeReplPath: cuaRepl.nodeReplPath, cuaReplConfigPath: cuaRepl.configPath };
	} catch (error) {
		return { ...status, brokerVerified: false, brokerError: error instanceof Error ? error.message : String(error) };
	}
}

export type ComputerUseRoute =
	| { kind: "cua_repl"; official: CuaReplToolSet }
	/** Deprecated: ChatGPT without its unified runtime still uses the ten typed tools. */
	| { kind: "legacy"; reason: string };

/**
 * Follow ChatGPT: use its cua_repl runtime when it has prepared one, and otherwise the ten typed
 * tools it still uses itself. Errors other than a missing runtime keep the cua_repl tools, whose
 * descriptions then say why Computer Use is not ready.
 */
export function selectComputerUseRoute(stateRoot = defaultStateRoot()): ComputerUseRoute {
	try {
		return { kind: "cua_repl", official: cuaReplToolDefinitions(readOfficialCuaReplServer({ configPath: pathConfigFile(stateRoot) }).env) };
	} catch (error) {
		if (error instanceof UnifiedRuntimeUnavailableError) return { kind: "legacy", reason: error.message };
		const unavailable = error instanceof Error ? error.message : String(error);
		const note = ` Computer Use is not ready: ${unavailable}`;
		return { kind: "cua_repl", official: {
			tools: [
				{
					name: "js",
					description: "Control native apps or browsers on the user's computer through OpenAI's official Computer Use JavaScript runtime (cua_repl)." + note,
					inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to run in the official cua_repl runtime." } }, additionalProperties: false },
					annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				},
				{
					name: "js_reset",
					description: "Reset the persistent cua_repl JavaScript session." + note,
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
					annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				},
			],
		} };
	}
}

/** Status of the route this process selected, so it matches the registered tools. */
export function computerUseStatus(route: ComputerUseRoute, stateRoot = defaultStateRoot()) {
	return route.kind === "legacy"
		? { route: "legacy", deprecated: `Using the older typed Computer Use tools because ${route.reason}`, ...getLegacyStatus(stateRoot) }
		: { route: "cua_repl", ...getDirectStatus(stateRoot) };
}
