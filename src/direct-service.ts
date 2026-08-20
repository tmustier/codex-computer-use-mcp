import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { appendAudit, type AuditRecord } from "./audit.ts";
import { PERMISSION_MODE } from "./config.ts";
import {
	callOfficialDirectTool,
	DirectBrokerCallError,
	verifyOfficialDirectBroker,
	type DirectBrokerElicitationRequest,
	type DirectBrokerElicitationResponse,
	type DirectBrokerResult,
} from "./direct-broker.ts";
import {
	MUTATING_METHODS,
	COMPUTER_USE_METHODS,
	isDirectMethod,
	validateDirectArguments,
	type DirectMethod,
	type DirectToolArguments,
} from "./tools.ts";

export interface DirectRequest {
	method: DirectMethod;
	arguments: DirectToolArguments;
}

export interface DirectResponse {
	ok: boolean;
	isError: boolean;
	content: Array<Record<string, unknown>>;
	details: Record<string, unknown>;
}

export interface DirectServiceDependencies {
	stateRoot?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void | Promise<void>;
	onElicitation?: (
		request: DirectBrokerElicitationRequest,
	) => DirectBrokerElicitationResponse | Promise<DirectBrokerElicitationResponse>;
	supportsOpenAiFormElicitation?: boolean;
	callTool?: typeof callOfficialDirectTool;
}

export class DirectPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DirectPolicyError";
	}
}

export function defaultStateRoot(): string {
	return process.env.CODEX_COMPUTER_USE_HOME || path.join(homedir(), ".direct-computer-use");
}

function auditAppIdentifier(rawApp: string | undefined): string | null {
	if (!rawApp) return null;
	return `target-sha256:${crypto.createHash("sha256").update(rawApp).digest("hex").slice(0, 16)}`;
}

function inputByteCount(args: DirectToolArguments): number {
	try {
		return Buffer.byteLength(JSON.stringify(args), "utf8");
	} catch {
		return 0;
	}
}

function contentMetadata(content: Array<Record<string, unknown>>): { types: string[]; bytes: number } {
	const types = [...new Set(content.map((item) => String(item.type ?? "unknown")))].sort();
	let bytes = 0;
	try { bytes = Buffer.byteLength(JSON.stringify(content), "utf8"); } catch { /* already validated by broker */ }
	return { types, bytes };
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "Direct Computer Use failed";
	return message
		.replace(/\/Users\/[^/\s]+/g, "~")
		.replace(/https?:\/\/\S+/g, "[url]")
		.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.slice(0, 500);
}

function rejectedMetadata(raw: unknown): { method: AuditRecord["method"]; inputBytes: number; mutating: boolean } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { method: "invalid_request", inputBytes: 0, mutating: false };
	const record = raw as Record<string, unknown>;
	const method = typeof record.method === "string" && isDirectMethod(record.method) ? record.method : "invalid_request";
	return {
		method,
		inputBytes: inputByteCount((record.arguments && typeof record.arguments === "object" ? record.arguments : {}) as DirectToolArguments),
		mutating: method !== "invalid_request" && MUTATING_METHODS.has(method),
	};
}

export async function executeDirectTool(raw: unknown, deps: DirectServiceDependencies = {}): Promise<DirectResponse> {
	const stateRoot = deps.stateRoot ?? defaultStateRoot();
	const runId = crypto.randomUUID();
	const startedAt = Date.now();
	let request: DirectRequest;
	try {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DirectPolicyError("Direct Computer Use request must be an object");
		const record = raw as Record<string, unknown>;
		if (typeof record.method !== "string" || !isDirectMethod(record.method)) throw new DirectPolicyError("Unknown direct Computer Use method");
		const args = validateDirectArguments(record.method, record.arguments ?? {});
		request = { method: record.method, arguments: args };
	} catch (error) {
		const rejected = rejectedMetadata(raw);
		const record: AuditRecord = {
			timestamp: new Date().toISOString(),
			runId,
			method: rejected.method,
			permissionMode: PERMISSION_MODE,
			app: null,
			mutating: rejected.mutating,
			authorization: "none",
			inputBytes: rejected.inputBytes,
			outcome: "policy_rejected",
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
		};
		try { await appendAudit(stateRoot, record); }
		catch { throw new Error("Direct Computer Use request was rejected, but secure audit logging failed"); }
		if (error instanceof DirectPolicyError) throw error;
		throw new DirectPolicyError("Direct Computer Use arguments did not match the typed schema");
	}

	const rawApp = request.method === "list_apps" ? undefined : request.arguments.app as string | undefined;
	let broker: DirectBrokerResult | undefined;
	let brokerFailure: DirectBrokerCallError | undefined;
	let brokerDispatchAttempted = false;
	let outcome = "failed";
	let brokerCleanupVerified = false;
	let response: DirectResponse | undefined;
	let thrown: Error | undefined;

	try {
		await deps.onProgress?.(`Direct ${request.method}: calling the signed official tool without a model turn…`);
		try {
			brokerDispatchAttempted = true;
			broker = await (deps.callTool ?? callOfficialDirectTool)(request.method, request.arguments, {
				signal: deps.signal,
				timeoutMs: 120_000,
				onElicitation: deps.onElicitation,
				supportsOpenAiFormElicitation: deps.supportsOpenAiFormElicitation,
			});
			brokerCleanupVerified = broker.brokerCleanupVerified;
		} catch (error) {
			if (error instanceof DirectBrokerCallError) {
				brokerFailure = error;
				brokerCleanupVerified = error.cleanupVerified;
			}
			throw error;
		}
		if (broker.modelTurnsStarted !== 0) throw new DirectPolicyError("Direct broker started a model turn");
		outcome = broker.isError ? "official_error" : "ok";
		response = {
			ok: !broker.isError,
			isError: broker.isError,
			content: broker.content,
			details: {
				runId,
				method: request.method,
				permissionMode: PERMISSION_MODE,
				app: auditAppIdentifier(rawApp),
				outcome,
				directCalls: 1,
				modelTurnsStarted: 0,
				ephemeralRuntimeContext: true,
				elicitationRequests: broker.elicitationRequests,
				brokerVersion: broker.brokerVersion,
				clientBuild: broker.clientBuild,
				durationMs: broker.durationMs,
				brokerCleanupVerified,
			},
		};
	} catch (error) {
		outcome = error instanceof DirectPolicyError ? "policy_violation" : deps.signal?.aborted ? "cancelled" : "broker_failed";
		if (!brokerDispatchAttempted) brokerCleanupVerified = true;
		thrown = new Error(safeErrorMessage(error));
	} finally {
		const metadata = broker ? contentMetadata(broker.content) : { types: [], bytes: 0 };
		const audit: AuditRecord = {
			timestamp: new Date().toISOString(),
			runId,
			method: request.method,
			permissionMode: PERMISSION_MODE,
			app: auditAppIdentifier(rawApp),
			mutating: MUTATING_METHODS.has(request.method),
			authorization: "no_permissions_unrestricted",
			inputBytes: inputByteCount(request.arguments),
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
		try { await appendAudit(stateRoot, audit); }
		catch { throw new Error(`Direct Computer Use ended with outcome ${outcome}, but secure audit logging failed`); }
	}
	if (thrown) throw thrown;
	if (!response) throw new Error("Direct Computer Use ended without a result");
	return response;
}

export function getDirectStatus(stateRoot = defaultStateRoot()): Record<string, unknown> {
	let brokerVerified = false;
	let brokerVersion: string | undefined;
	let clientBuild: string | undefined;
	try {
		({ brokerVersion, clientBuild } = verifyOfficialDirectBroker());
		brokerVerified = true;
	} catch {
		// Status remains readable without exposing local verification details.
	}
	return {
		stateRoot,
		permissionMode: PERMISSION_MODE,
		brokerVerified,
		...(brokerVersion ? { brokerVersion } : {}),
		...(clientBuild ? { clientBuild } : {}),
		officialElicitationsAuthoritative: true,
		architecture: "official-codex-app-server-direct-mcp-tool-call",
		nestedModel: false,
		modelUsage: false,
		ephemeralZeroTurnRuntimeContextRequired: true,
		wrapperPermissionPrompts: false,
		officialApprovalPolicy: "full-access",
		officialAppApprovalHandling: "auto-approved-by-codex-full-access",
		officialElicitationHandling: "forwarded-if-emitted",
		wrapperAuthorization: "unrestricted",
		appSelectors: "passed-through",
		availableMethods: [...COMPUTER_USE_METHODS],
		supportedMethods: [...COMPUTER_USE_METHODS],
		auditPath: path.join(stateRoot, "audit", "direct-computer-use.jsonl"),
	};
}
