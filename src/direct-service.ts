import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { appendAudit, type AuditRecord } from "./audit.ts";
import { loadConfig, type ExtensionConfig, type PermissionMode } from "./config.ts";
import {
	callOfficialDirectTool,
	DirectBrokerCallError,
	verifyOfficialDirectBroker,
	type DirectBrokerElicitationRequest,
	type DirectBrokerElicitationResponse,
	type DirectBrokerResult,
} from "./direct-broker.ts";
import { acquireAppLock, globalAppLockRoot, type AppLock } from "./lock.ts";
import {
	frontmostBundleId,
	frontmostBundleIdAsync,
	resolveAppIdentity,
	watchTargetFrontmost,
	type ResolvedAppIdentity,
	type TargetFrontmostWatcher,
} from "./system.ts";
import {
	MUTATING_METHODS,
	OFFICIAL_METHODS,
	isDirectMethod,
	targetAppFor,
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
	resolveIdentity?: typeof resolveAppIdentity;
	frontmost?: typeof frontmostBundleId;
	frontmostAsync?: typeof frontmostBundleIdAsync;
	watchFocus?: typeof watchTargetFrontmost;
	acquireLock?: typeof acquireAppLock;
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

function auditAppIdentifier(rawApp: string | undefined, identity?: ResolvedAppIdentity): string | null {
	if (!rawApp) return null;
	if (identity?.bundleId) return identity.bundleId;
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

function authorizationFor(_mode: PermissionMode, _method: DirectMethod): AuditRecord["authorization"] {
	return "no_permissions_unrestricted";
}

export async function executeDirectTool(raw: unknown, deps: DirectServiceDependencies = {}): Promise<DirectResponse> {
	const stateRoot = deps.stateRoot ?? defaultStateRoot();
	const runId = crypto.randomUUID();
	const startedAt = Date.now();
	const config = await loadConfig();
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
			permissionMode: config.permissionMode,
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
			backgroundPreserved: null,
			brokerCleanupVerified: true,
			appLeaseReleased: true,
			resultContentTypes: [],
			resultBytes: 0,
		};
		try { await appendAudit(stateRoot, record); }
		catch { throw new Error("Direct Computer Use request was rejected, but secure audit logging failed"); }
		if (error instanceof DirectPolicyError) throw error;
		throw new DirectPolicyError("Direct Computer Use arguments did not match the typed schema");
	}

	const rawApp = targetAppFor(request.method, request.arguments);
	const identity = rawApp ? (deps.resolveIdentity ?? resolveAppIdentity)(rawApp) : undefined;
	if (rawApp && !identity?.bundleId) {
		const audit: AuditRecord = {
			timestamp: new Date().toISOString(), runId, method: request.method, permissionMode: config.permissionMode,
			app: auditAppIdentifier(rawApp, identity), mutating: MUTATING_METHODS.has(request.method),
			authorization: authorizationFor(config.permissionMode, request.method), inputBytes: inputByteCount(request.arguments),
			outcome: "identity_rejected", durationMs: Date.now() - startedAt, brokerVersion: null, clientBuild: null,
			directCalls: 0, modelTurnsStarted: 0, ephemeralThread: null, elicitationRequests: 0,
			backgroundPreserved: null, brokerCleanupVerified: true, appLeaseReleased: true, resultContentTypes: [], resultBytes: 0,
		};
		try { await appendAudit(stateRoot, audit); }
		catch { throw new Error("Direct Computer Use identity validation failed, and secure audit logging also failed"); }
		throw new DirectPolicyError("Target app could not be resolved to a canonical installed bundle identifier");
	}

	const canonicalArgs: DirectToolArguments = identity?.bundleId
		? { ...request.arguments, app: identity.bundleId }
		: { ...request.arguments };
	let lock: AppLock | undefined;
	let watcher: TargetFrontmostWatcher | undefined;
	let focusTimer: NodeJS.Timeout | undefined;
	let focusSample: Promise<void> | undefined;
	let focusSamplingFailed = false;
	let frontBefore: string | undefined;
	let targetBecameFrontmost = false;
	let unrelatedFocusChanges = false;
	let broker: DirectBrokerResult | undefined;
	let brokerFailure: DirectBrokerCallError | undefined;
	let brokerDispatchAttempted = false;
	let outcome = "failed";
	let brokerCleanupVerified = false;
	let response: DirectResponse | undefined;
	let thrown: Error | undefined;

	try {
		if (identity) lock = await (deps.acquireLock ?? acquireAppLock)(globalAppLockRoot(), identity.leaseId, runId);
		if (identity?.bundleId) {
			frontBefore = (deps.frontmost ?? frontmostBundleId)();
			if (!frontBefore) throw new DirectPolicyError("Could not observe the frontmost app before direct dispatch");
			if (frontBefore.toLowerCase() === identity.bundleId.toLowerCase()) {
				throw new DirectPolicyError("Target app is already frontmost; direct background-only dispatch was refused");
			}
			watcher = await (deps.watchFocus ?? watchTargetFrontmost)();
			const sample = async (): Promise<void> => {
				if (focusSample) return focusSample;
				focusSample = (async () => {
					const current = await (deps.frontmostAsync ?? frontmostBundleIdAsync)();
					if (!current) return;
					if (current.toLowerCase() === identity.bundleId!.toLowerCase()) targetBecameFrontmost = true;
					else if (current !== frontBefore) unrelatedFocusChanges = true;
				})().finally(() => { focusSample = undefined; });
				return focusSample;
			};
			await sample().catch(() => { focusSamplingFailed = true; });
			focusTimer = setInterval(() => {
				void sample().catch(() => { focusSamplingFailed = true; });
			}, 100);
			focusTimer.unref();
		}

		await deps.onProgress?.(`Direct ${request.method}: verified target lease; calling the signed official tool without a model turn…`);
		try {
			brokerDispatchAttempted = true;
			broker = await (deps.callTool ?? callOfficialDirectTool)(request.method, canonicalArgs, {
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
		if (broker.modelTurnsStarted !== 0 || broker.ephemeralThread !== true) {
			throw new DirectPolicyError("Direct broker violated the zero-model-turn architecture");
		}
		outcome = broker.isError ? "official_error" : "ok";
		response = {
			ok: !broker.isError,
			isError: broker.isError,
			content: broker.content,
			details: {
				runId,
				method: request.method,
				permissionMode: config.permissionMode,
				app: identity?.bundleId ?? null,
				outcome,
				directCalls: 1,
				modelTurnsStarted: 0,
				ephemeralRuntimeContext: true,
				elicitationRequests: broker.elicitationRequests,
				brokerVersion: broker.brokerVersion,
				clientBuild: broker.clientBuild,
				durationMs: broker.durationMs,
			},
		};
	} catch (error) {
		outcome = error instanceof DirectPolicyError ? "policy_violation" : deps.signal?.aborted ? "cancelled" : "broker_failed";
		if (!brokerDispatchAttempted) brokerCleanupVerified = true;
		thrown = new Error(safeErrorMessage(error));
	} finally {
		if (focusTimer) clearInterval(focusTimer);
		if (focusSample) await focusSample.catch(() => { focusSamplingFailed = true; });
		let watcherFailed = focusSamplingFailed;
		if (watcher) {
			watcherFailed ||= !watcher.healthy();
			try { await watcher.stop(); }
			catch { watcherFailed = true; }
			if (identity?.bundleId) targetBecameFrontmost ||= watcher.becameFrontmost(identity.bundleId);
		}
		if (identity?.bundleId) {
			const frontAfter = (deps.frontmost ?? frontmostBundleId)();
			if (!frontAfter) watcherFailed = true;
			else if (frontAfter.toLowerCase() === identity.bundleId.toLowerCase()) targetBecameFrontmost = true;
			else if (frontBefore && frontAfter !== frontBefore) unrelatedFocusChanges = true;
		}
		const backgroundPreserved = identity ? !targetBecameFrontmost && !watcherFailed : null;
		if (identity && backgroundPreserved !== true && !thrown) {
			outcome = "focus_violation";
			thrown = new DirectPolicyError("Target focus changed or focus telemetry failed; the completed tool call is not trusted as background-safe");
			response = undefined;
		}
		let releaseFailed = false;
		try { await lock?.release(); } catch { releaseFailed = true; }
		if (releaseFailed) {
			outcome = "lease_cleanup_failed";
			thrown = new Error("Direct Computer Use app lease did not release cleanly");
			response = undefined;
		}
		const metadata = broker ? contentMetadata(broker.content) : { types: [], bytes: 0 };
		const audit: AuditRecord = {
			timestamp: new Date().toISOString(),
			runId,
			method: request.method,
			permissionMode: config.permissionMode,
			app: auditAppIdentifier(rawApp, identity),
			mutating: MUTATING_METHODS.has(request.method),
			authorization: authorizationFor(config.permissionMode, request.method),
			inputBytes: inputByteCount(canonicalArgs),
			outcome,
			durationMs: Date.now() - startedAt,
			brokerVersion: broker?.brokerVersion ?? brokerFailure?.brokerVersion ?? null,
			clientBuild: broker?.clientBuild ?? brokerFailure?.clientBuild ?? null,
			directCalls: broker ? 1 : brokerFailure?.directCalls ?? 0,
			modelTurnsStarted: broker?.modelTurnsStarted ?? brokerFailure?.modelTurnsStarted ?? 0,
			ephemeralThread: broker?.ephemeralThread ?? brokerFailure?.ephemeralThread ?? null,
			elicitationRequests: broker?.elicitationRequests ?? brokerFailure?.elicitationRequests ?? 0,
			backgroundPreserved,
			brokerCleanupVerified,
			appLeaseReleased: !releaseFailed,
			resultContentTypes: metadata.types,
			resultBytes: metadata.bytes,
		};
		try { await appendAudit(stateRoot, audit); }
		catch { throw new Error(`Direct Computer Use ended with outcome ${outcome}, but secure audit logging failed`); }
	}
	if (thrown) throw thrown;
	if (!response) throw new Error("Direct Computer Use ended without a result");
	response.details.backgroundPreserved = identity ? true : null;
	response.details.unrelatedFocusChanges = unrelatedFocusChanges;
	response.details.brokerCleanupVerified = brokerCleanupVerified;
	return response;
}

export async function getDirectStatus(stateRoot = defaultStateRoot()): Promise<Record<string, unknown>> {
	const config: ExtensionConfig = await loadConfig();
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
		permissionMode: config.permissionMode,
		brokerVerified,
		...(brokerVersion ? { brokerVersion } : {}),
		...(clientBuild ? { clientBuild } : {}),
		officialElicitationsAuthoritative: true,
		architecture: "official-codex-app-server-direct-mcp-tool-call",
		nestedModel: false,
		modelUsage: false,
		ephemeralZeroTurnRuntimeContextRequired: true,
		wrapperPermissionPrompts: false,
		officialElicitationHandling: "forwarded-when-client-supported",
		wrapperAuthorization: "unrestricted",
		availableMethods: [...OFFICIAL_METHODS],
		supportedMethods: [...OFFICIAL_METHODS],
		appLockRoot: globalAppLockRoot(),
		auditPath: path.join(stateRoot, "audit", "direct-computer-use.jsonl"),
	};
}
