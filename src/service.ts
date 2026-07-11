import crypto from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { appendAudit, type AuditRecord } from "./audit.ts";
import { loadConfig, type ExtensionConfig } from "./config.ts";
import { acquireAppLock, type AppLock } from "./lock.ts";
import {
  COMPUTER_USE_TOOLS,
  MODEL,
  PolicyError,
  allowedToolsForRequest,
  createDictionaryArgumentValidator,
  validateObservedMethods,
  validateResolvedAppIdentity,
  validateRequest,
  type NativeAppInput,
} from "./policy.ts";
import { buildPrompt } from "./prompt.ts";
import { runOfficialCodex, verifyOfficialBroker, type FirstPartyInterruption, type RunnerResult } from "./runner.ts";
import {
  ensureAppRunningInBackground,
  frontmostBundleId,
  frontmostBundleIdAsync,
  resolveAppIdentity,
  type TargetFrontmostWatcher,
  watchTargetFrontmost,
} from "./system.ts";

export interface OperationDependencies {
  stateRoot?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface OperationResponse {
  ok: boolean;
  isError: boolean;
  text: string;
  details: Record<string, unknown>;
}

export function defaultStateRoot(): string {
  return process.env.CODEX_COMPUTER_USE_HOME || path.join(homedir(), ".codex-computer-use-mcp");
}

function usageText(result: RunnerResult): string {
  const usage = result.usage;
  return `Codex usage: ${usage.input} input (${usage.cachedInput} cached), ${usage.output} output tokens`;
}

function safeDisplay(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function auditAppIdentifier(app: string | undefined, canonicalBundleId: string | undefined): string | null {
  if (!app) return null;
  if (canonicalBundleId) return canonicalBundleId;
  return `target-sha256:${crypto.createHash("sha256").update(app).digest("hex").slice(0, 16)}`;
}

function rejectedInputMetadata(raw: unknown): { operation: string; app: string | null; mutating: boolean; cleanup: boolean; inputBytes: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { operation: "invalid_request", app: null, mutating: false, cleanup: false, inputBytes: 0 };
  }
  const value = raw as Record<string, unknown>;
  const operation = typeof value.mode === "string" && ["list", "inspect", "act", "dictionary_lookup", "configure"].includes(value.mode)
    ? value.mode
    : "invalid_request";
  const app = typeof value.app === "string" ? auditAppIdentifier(value.app, undefined) : null;
  const input = [value.task, value.query, value.cleanup_instructions]
    .filter((item): item is string => typeof item === "string")
    .join("");
  return {
    operation,
    app,
    mutating: operation === "act" || operation === "dictionary_lookup" || operation === "configure",
    cleanup: value.cleanup === true,
    inputBytes: Buffer.byteLength(input, "utf8"),
  };
}

function interruptionMessage(kind: FirstPartyInterruption, app: string, methods: string[]): string {
  const prior = methods.length
    ? ` Earlier successful calls (${methods.join(", ")}) may already have changed state; cleanup is unverified.`
    : " No successful Computer Use call was observed before the interruption.";
  switch (kind) {
    case "app_approval":
      return `Official Computer Use app approval is required for ${app}. Complete or deny that first-party app approval in an official interactive session, then retry only if approved.${prior}`;
    case "sensitive_action":
      return `Official Computer Use sensitive-action confirmation interrupted work in ${app}. Review that specific first-party action prompt; wrapper full-permissions does not bypass it.${prior}`;
    case "os_permission":
      return `A macOS privacy permission interrupted Computer Use for ${app}. Review the relevant macOS permission directly; the wrapper does not alter OS privacy controls.${prior}`;
    case "unknown_elicitation":
      return `An unclassified first-party Computer Use elicitation interrupted work in ${app}. Review it in an official interactive session rather than assuming it is app approval.${prior}`;
  }
}

export async function executeOperation(raw: unknown, deps: OperationDependencies = {}): Promise<OperationResponse> {
  const stateDir = deps.stateRoot || defaultStateRoot();
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const config = await loadConfig(stateDir);
  const permissionMode = config.permissionMode;
  let request: ReturnType<typeof validateRequest>;
  try {
    request = validateRequest(raw as NativeAppInput, permissionMode);
  } catch (error) {
    const rejected = rejectedInputMetadata(raw);
    const audit: AuditRecord = {
      timestamp: new Date().toISOString(),
      runId,
      operation: rejected.operation,
      permissionMode,
      app: rejected.app,
      mutating: rejected.mutating,
      cleanupRequested: rejected.cleanup,
      userConfirmed: false,
      authorization: permissionMode === "full-permissions" ? "full_permissions_config" : "none",
      inputBytes: rejected.inputBytes,
      outcome: "policy_rejected",
      durationMs: Date.now() - startedAt,
      model: MODEL,
      usage: { input: 0, cachedInput: 0, output: 0 },
      computerUseCalls: 0,
      backgroundPreserved: null,
      cleanupVerified: null,
    };
    try {
      await appendAudit(stateDir, audit, "background-computer-use.jsonl");
    } catch {
      throw new Error("Computer Use request was rejected, but secure audit logging failed");
    }
    if (error instanceof PolicyError) throw error;
    throw new PolicyError("Request did not pass the Computer Use policy");
  }

  let userConfirmed = false;
  let authorization: AuditRecord["authorization"] =
    permissionMode === "full-permissions" ? "full_permissions_config" : "none";
  const locks: AppLock[] = [];
  let runner: RunnerResult | undefined;
  let outcome = "failed";
  let backgroundPreserved: boolean | null = null;
  let cleanupVerified: boolean | null = null;
  const app = request.app;
  let targetIdentity = app ? resolveAppIdentity(app) : undefined;
  const initialTargetLeaseId = targetIdentity?.leaseId;
  let targetLeaseId = initialTargetLeaseId;
  let canonicalTargetApp = targetIdentity?.bundleId;
  let frontBefore: string | undefined;
  let targetBecameFrontmost = false;
  let unrelatedFocusChanges = false;
  let focusWatcher: TargetFrontmostWatcher | undefined;
  let focusWatcherFailed = false;

  try {
    validateResolvedAppIdentity(request, targetIdentity?.bundleId, targetIdentity?.verifiedSystemDictionary === true);
    if (initialTargetLeaseId) locks.push(await acquireAppLock(stateDir, initialTargetLeaseId, runId));

    frontBefore = frontmostBundleId();
    if (!frontBefore) throw new PolicyError("Could not observe the frontmost app; refusing to spend Codex quota without background verification");
    let focusSamplePromise: Promise<void> | undefined;
    const sampleFocus = (): Promise<void> => {
      if (focusSamplePromise) return focusSamplePromise;
      focusSamplePromise = (async () => {
        const current = await frontmostBundleIdAsync();
        if (!current) return;
        if (canonicalTargetApp && current.toLowerCase() === canonicalTargetApp.toLowerCase()) targetBecameFrontmost = true;
        else if (current !== frontBefore) unrelatedFocusChanges = true;
      })().finally(() => {
        focusSamplePromise = undefined;
      });
      return focusSamplePromise;
    };
    if (app) focusWatcher = await watchTargetFrontmost();
    const focusMonitor = setInterval(() => void sampleFocus(), 250);
    focusMonitor.unref();
    try {
      if (app) {
        targetIdentity = await ensureAppRunningInBackground(app, targetIdentity);
        canonicalTargetApp = targetIdentity.bundleId;
        if (!canonicalTargetApp) throw new PolicyError("Could not resolve the background-launched app to a canonical bundle ID");
        targetLeaseId = canonicalTargetApp.toLowerCase();
        validateResolvedAppIdentity(request, targetIdentity.bundleId, targetIdentity.verifiedSystemDictionary);
        if (targetLeaseId !== initialTargetLeaseId) locks.push(await acquireAppLock(stateDir, targetLeaseId, runId));
        await sampleFocus();
        if (frontmostBundleId()?.toLowerCase() === targetLeaseId) targetBecameFrontmost = true;
        if (targetBecameFrontmost) throw new PolicyError("The target app became frontmost during background launch; background-only guarantee failed");
      }
      await deps.onProgress?.(`${permissionMode === "full-permissions" ? "FULL PERMISSIONS; " : ""}Leased ${app ?? "app inventory"}; starting signed Codex Computer Use worker…`);
      runner = await runOfficialCodex(buildPrompt(request, canonicalTargetApp), {
        signal: deps.signal,
        timeoutMs: 300_000,
        allowedTools: allowedToolsForRequest(request),
        targetApp: request.app,
        targetAppAliases: [canonicalTargetApp, targetLeaseId, initialTargetLeaseId].filter((value): value is string => Boolean(value)),
        reasoningEffort: request.reasoningEffort,
        maxToolCalls: request.maxComputerUseCalls,
        validateCallArguments: request.mode === "dictionary_lookup" ? createDictionaryArgumentValidator(request.query!) : undefined,
      });
    } finally {
      clearInterval(focusMonitor);
      await sampleFocus();
      if (focusWatcher) {
        focusWatcherFailed = !focusWatcher.healthy();
        await focusWatcher.stop();
        if (canonicalTargetApp) targetBecameFrontmost ||= focusWatcher.becameFrontmost(canonicalTargetApp);
      }
    }

    if (focusWatcherFailed) throw new PolicyError("Target focus-event monitor exited before the Computer Use worker");
    if (runner.policyViolation) {
      outcome = "policy_violation";
      throw new PolicyError(`${runner.policyViolation}${request.mutating ? "; target cleanup is not verified—inspect and restore the app before retrying" : ""}`);
    }
    if (runner.firstPartyInterruption) {
      outcome = `first_party_${runner.firstPartyInterruption}`;
      return {
        ok: false,
        isError: true,
        text: `[${permissionMode}] ${interruptionMessage(runner.firstPartyInterruption, app ?? "the target app", runner.computerUseMethods)} Do not retry automatically. ${usageText(runner)}`,
        details: {
          runId,
          mode: request.mode,
          permissionMode,
          app,
          outcome,
          approvalRequired: runner.firstPartyInterruption === "app_approval",
          firstPartyInterruption: runner.firstPartyInterruption,
          usedCapabilities: runner.computerUseMethods,
          usage: runner.usage,
          model: MODEL,
          durationMs: runner.durationMs,
          retryAllowed: false,
        },
      };
    }
    if (runner.exitCode !== 0 || !runner.result) {
      outcome = runner.errorKind ?? "broker_failed";
      throw new Error(`Official Codex broker failed (${runner.errorKind ?? "unknown"})${request.mutating ? "; target cleanup is not verified—inspect and restore the app before retrying" : ""}`);
    }
    const result = runner.result;
    if (result.mode !== request.mode) throw new PolicyError("Codex returned a mismatched mode");
    if (
      app &&
      ![app, canonicalTargetApp, targetLeaseId]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase() === result.app.toLowerCase())
    ) {
      throw new PolicyError("Codex returned a mismatched target app");
    }
    if (result.status === "approval_required" || result.approvalRequired) {
      outcome = "unverified_approval_claim";
      throw new Error("Codex claimed app approval was required without an observed official approval event; no task completion is trusted");
    }
    if (result.status !== "ok") {
      outcome = `computer_use_${result.status}`;
      throw new Error(`Computer Use returned ${result.status}${request.mutating ? "; target cleanup is not verified—inspect and restore the app before retrying" : ""}`);
    }
    validateObservedMethods(request, runner.computerUseMethods);

    const frontAfter = frontmostBundleId();
    if (!frontAfter) throw new PolicyError("Could not verify the final frontmost app state");
    if (targetLeaseId && frontAfter.toLowerCase() === targetLeaseId) targetBecameFrontmost = true;
    else if (frontAfter !== frontBefore) unrelatedFocusChanges = true;
    backgroundPreserved = !targetBecameFrontmost;
    if (!backgroundPreserved) throw new PolicyError("The confirmed target app became frontmost; background-only guarantee failed");
    cleanupVerified = request.mutating ? (request.cleanup ? result.cleaned : null) : true;
    if (request.mutating && request.cleanup && result.cleaned !== true) throw new PolicyError("Requested cleanup was not verified");

    outcome = "ok";
    if (request.mode === "list") {
      const safeApps = result.apps.map((item) => ({ name: safeDisplay(item.name, 120), bundleId: safeDisplay(item.bundleId, 160) }));
      const lines = safeApps.map((item) => `${item.name} (${item.bundleId})`);
      return {
        ok: true,
        isError: false,
        text: `[${permissionMode}] Discovered ${safeApps.length} apps through signed Codex Computer Use:\n${lines.join("\n")}\n\n${usageText(runner)}.`,
        details: {
          runId,
          mode: request.mode,
          permissionMode,
          outcome,
          apps: safeApps,
          cleaned: true,
          backgroundPreserved,
          unrelatedFocusChanges,
          usedCapabilities: runner.computerUseMethods,
          usage: runner.usage,
          model: MODEL,
          durationMs: runner.durationMs,
        },
      };
    }
    return {
      ok: true,
      isError: false,
      text: `[${permissionMode}] ${app} ${request.mode} completed through signed Codex Computer Use. ${safeDisplay(result.summary, 1000)} Background preserved: yes. ${request.cleanup ? "Cleanup verified: yes. " : "Cleanup not requested. "}Capabilities used: ${runner.computerUseMethods.join(", ")}. ${usageText(runner)}.`,
      details: {
        runId,
        mode: request.mode,
        permissionMode,
        app,
        outcome,
        summary: safeDisplay(result.summary, 1000),
        cleaned: result.cleaned,
        backgroundPreserved,
        unrelatedFocusChanges,
        approvalRequired: false,
        usedCapabilities: runner.computerUseMethods,
        usage: runner.usage,
        model: MODEL,
        durationMs: runner.durationMs,
      },
    };
  } finally {
    let releaseFailure = false;
    for (const held of locks.reverse()) {
      try {
        await held.release();
      } catch {
        releaseFailure = true;
      }
    }
    const audit: AuditRecord = {
      timestamp: new Date().toISOString(),
      runId,
      operation: request.mode,
      permissionMode,
      app: auditAppIdentifier(app, canonicalTargetApp),
      mutating: request.mutating,
      cleanupRequested: request.cleanup,
      userConfirmed,
      authorization,
      inputBytes: Buffer.byteLength(`${request.task ?? request.query ?? ""}${request.cleanupInstructions ?? ""}`, "utf8"),
      outcome,
      durationMs: Date.now() - startedAt,
      model: MODEL,
      usage: runner?.usage ?? { input: 0, cachedInput: 0, output: 0 },
      computerUseCalls: runner?.computerUseMethods.length ?? 0,
      backgroundPreserved,
      cleanupVerified,
    };
    try {
      await appendAudit(stateDir, audit, "background-computer-use.jsonl");
    } catch {
      throw new Error(`Computer Use ended with outcome ${outcome}, but secure audit logging failed${request.mutating ? "; prior mutations and cleanup state may require manual inspection" : ""}`);
    }
    if (releaseFailure) {
      throw new Error(`Computer Use ended with outcome ${outcome}, but one or more app leases did not release cleanly`);
    }
  }
}

export async function getStatus(stateRoot = defaultStateRoot()): Promise<Record<string, unknown>> {
  const config: ExtensionConfig = await loadConfig(stateRoot);
  let brokerVerified = false;
  let brokerVersion: string | undefined;
  try {
    brokerVersion = verifyOfficialBroker();
    brokerVerified = true;
  } catch {
    // Status remains readable on incompatible hosts without exposing local verification details.
  }
  return {
    stateRoot,
    permissionMode: config.permissionMode,
    model: MODEL,
    brokerVerified,
    ...(brokerVersion ? { brokerVersion } : {}),
    officialApprovalAuthoritative: true,
    supportedMethods: [...COMPUTER_USE_TOOLS],
    auditPath: path.join(stateRoot, "audit", "background-computer-use.jsonl"),
  };
}
