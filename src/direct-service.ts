import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { appendAudit, type AuditRecord } from "./audit.ts";
import {
	callOfficialDirectTool,
	DirectBrokerCallError,
	verifyOfficialDirectBroker,
	type DirectBrokerElicitationRequest,
	type DirectBrokerElicitationResponse,
	type DirectBrokerResult,
} from "./direct-broker.ts";
import {
	COMPUTER_USE_METHODS,
	validateDirectArguments,
	type DirectMethod,
	type DirectToolArguments,
	type JsonObject,
	type JsonValue,
} from "./tools.ts";

const requestSchema = z.object({
	method: z.enum(COMPUTER_USE_METHODS),
	arguments: z.record(z.string(), z.json()).default({}),
});
interface DirectRequest {
	method: DirectMethod;
	arguments: DirectToolArguments;
}

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
	callTool?: typeof callOfficialDirectTool;
}

function defaultStateRoot(): string {
	return process.env.CODEX_COMPUTER_USE_HOME || path.join(homedir(), ".direct-computer-use");
}

function auditAppIdentifier(app?: string): string | null {
	if (!app) return null;
	return `target-sha256:${crypto.createHash("sha256").update(app).digest("hex").slice(0, 16)}`;
}

function inputByteCount(value: JsonValue): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function contentMetadata(content: JsonObject[]) {
	const types = [...new Set(content.map((item) => String(item.type ?? "unknown")))].sort();
	return { types, bytes: Buffer.byteLength(JSON.stringify(content), "utf8") };
}

export async function executeDirectTool(raw: JsonValue, deps: DirectServiceDependencies = {}): Promise<DirectResponse> {
	const stateRoot = deps.stateRoot ?? defaultStateRoot();
	const runId = crypto.randomUUID();
	const startedAt = Date.now();
	let request: DirectRequest;
	try {
		const envelope = requestSchema.parse(raw);
		request = {
			method: envelope.method,
			arguments: validateDirectArguments(envelope.method, envelope.arguments),
		};
	} catch {
		await appendAudit(stateRoot, {
			timestamp: new Date().toISOString(),
			runId,
			method: "invalid_request",
			app: null,
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
		throw new Error("Direct Computer Use request did not match a tool schema");
	}

	const app = request.method === "list_apps" ? undefined : String(request.arguments.app);
	let broker: DirectBrokerResult | undefined;
	let brokerFailure: DirectBrokerCallError | undefined;
	let outcome = "broker_failed";
	let brokerCleanupVerified = false;
	let failure: Error | undefined;

	try {
		broker = await (deps.callTool ?? callOfficialDirectTool)(request.method, request.arguments, {
			signal: deps.signal,
			timeoutMs: 120_000,
			onElicitation: deps.onElicitation,
			supportsOpenAiFormElicitation: deps.supportsOpenAiFormElicitation,
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
		method: request.method,
		app: auditAppIdentifier(app),
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
	await appendAudit(stateRoot, audit);
	if (failure) throw failure;
	if (!broker) throw new Error("Direct Computer Use ended without a result");

	return {
		isError: broker.isError,
		content: broker.content,
		structuredContent: broker.structuredContent,
	};
}

interface DirectStatus extends JsonObject {
	stateRoot: string;
	permissionMode: "no-permissions";
	brokerVerified: boolean;
	brokerVersion?: string;
	clientBuild?: string;
	methods: DirectMethod[];
}

export function getDirectStatus(stateRoot = defaultStateRoot()): DirectStatus {
	const status: DirectStatus = {
		stateRoot,
		permissionMode: "no-permissions",
		brokerVerified: false,
		methods: [...COMPUTER_USE_METHODS],
	};
	try {
		const verification = verifyOfficialDirectBroker();
		status.brokerVerified = true;
		status.brokerVersion = verification.brokerVersion;
		status.clientBuild = verification.clientBuild;
	} catch {}
	return status;
}
