import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { appendAudit, type AuditRecord } from "./audit.ts";
import {
	callOfficialCuaRepl,
	DirectBrokerCallError,
	pathConfigFile,
	readOfficialCuaReplServer,
	verifyOfficialDirectBroker,
	type DirectBrokerElicitationRequest,
	type DirectBrokerElicitationResponse,
	type DirectBrokerResult,
} from "./direct-broker.ts";
import {
	CUA_REPL_TOOLS,
	cuaReplToolDefinitions,
	type CuaReplArguments,
	type CuaReplTool,
	type CuaReplToolSet,
	type JsonObject,
	type JsonValue,
} from "./tools.ts";

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

function contentMetadata(content: JsonObject[]) {
	const types = [...new Set(content.map((item) => String(item.type ?? "unknown")))].sort();
	return { types, bytes: Buffer.byteLength(JSON.stringify(content), "utf8") };
}

/** Give the app-server room beyond node_repl's own execution timeout, which defaults to 30 seconds. */
const executionTimeoutSchema = z.object({ timeout_ms: z.number().optional() });

function requestTimeoutMs(tool: CuaReplTool, args: CuaReplArguments): number {
	const requested = executionTimeoutSchema.safeParse(args);
	const executionMs = tool === "js" && requested.success ? requested.data.timeout_ms ?? 30_000 : 30_000;
	// agent-default (not a user rule): 2026-11-05. 120s floor kept from the earlier per-method timeout.
	return Math.max(120_000, executionMs + 30_000);
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
	let broker: DirectBrokerResult | undefined;
	let brokerFailure: DirectBrokerCallError | undefined;
	let outcome = "broker_failed";
	let brokerCleanupVerified = false;
	let failure: Error | undefined;

	try {
		broker = await (deps.callTool ?? callOfficialCuaRepl)(tool, args, {
			signal: deps.signal,
			timeoutMs: requestTimeoutMs(tool, args),
			onElicitation: deps.onElicitation,
			supportsOpenAiFormElicitation: deps.supportsOpenAiFormElicitation,
			configPath: pathConfigFile(stateRoot),
		});
		brokerCleanupVerified = broker.brokerCleanupVerified;
		outcome = broker.isError ? "official_error" : "ok";
	} catch (error) {
		if (error instanceof DirectBrokerCallError) {
			brokerFailure = error;
			brokerCleanupVerified = error.cleanupVerified;
		}
		if (deps.signal?.aborted) outcome = "cancelled";
		failure = error instanceof Error ? error : new Error("Direct Computer Use failed");
	}

	const metadata = broker ? contentMetadata(broker.content) : { types: [], bytes: 0 };
	const audit: AuditRecord = {
		timestamp: new Date().toISOString(),
		runId,
		method: tool,
		inputBytes: inputByteCount(args),
		outcome,
		durationMs: Date.now() - startedAt,
		brokerVersion: broker?.brokerVersion ?? brokerFailure?.brokerVersion ?? null,
		clientBuild: broker?.clientBuild ?? brokerFailure?.clientBuild ?? null,
		directCalls: broker ? 1 : brokerFailure?.directCalls ?? 0,
		modelTurnsStarted: broker?.modelTurnsStarted ?? brokerFailure?.modelTurnsStarted ?? 0,
		ephemeralThread: broker?.ephemeralThread ?? brokerFailure?.ephemeralThread ?? null,
		elicitationRequests: broker?.elicitationRequests ?? brokerFailure?.elicitationRequests ?? 0,
		brokerCleanupVerified,
		resultContentTypes: metadata.types,
		resultBytes: metadata.bytes,
	};
	await appendAudit(stateRoot, audit);
	if (failure) throw failure;
	if (!broker) throw new Error("Direct Computer Use ended without a result");

	return {
		isError: broker.isError,
		content: broker.content,
		structuredContent: broker.structuredContent,
	};
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

export interface OfficialToolDefinitions extends CuaReplToolSet {
	/** Why the official definitions could not be read; the fallback definitions name it. */
	unavailable?: string;
}

const FALLBACK_JS_DESCRIPTION = "Control native apps or browsers on the user's computer through OpenAI's official Computer Use JavaScript runtime (cua_repl).";

/** The official tool definitions for the installed ChatGPT, or minimal stand-ins that say why they are missing. */
export function officialToolDefinitions(stateRoot = defaultStateRoot()): OfficialToolDefinitions {
	try {
		return cuaReplToolDefinitions(readOfficialCuaReplServer({ configPath: pathConfigFile(stateRoot) }).env);
	} catch (error) {
		const unavailable = error instanceof Error ? error.message : String(error);
		const note = ` Computer Use is not ready: ${unavailable}`;
		return {
			unavailable,
			tools: [
				{
					name: "js",
					description: FALLBACK_JS_DESCRIPTION + note,
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
		};
	}
}
