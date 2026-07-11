import crypto from "node:crypto";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendAudit, type AuditRecord } from "../../dist/audit.js";
import { ConfigError, loadConfig, saveConfig } from "../../dist/config.js";
import { COMPUTER_USE_TOOLS, MODEL } from "../../dist/policy.js";
import { executeOperation, getStatus } from "../../dist/service.js";

const Params = Type.Object({
  mode: StringEnum(["list", "inspect", "act", "dictionary_lookup"] as const, {
    description: "safe mode permits only list; targeted modes require explicitly acknowledged broad full-permissions",
  }),
  app: Type.Optional(Type.String({ maxLength: 500, description: "App name, bundle identifier, or app-bundle path" })),
  task: Type.Optional(Type.String({ maxLength: 4000, description: "Concrete target-app task for act mode" })),
  query: Type.Optional(Type.String({ maxLength: 200, description: "Local word or phrase for dictionary_lookup" })),
  cleanup: Type.Optional(Type.Boolean({ description: "Restore transient state and verify cleanup" })),
  cleanup_instructions: Type.Optional(Type.String({ maxLength: 2000, description: "Optional cleanup postcondition" })),
  required_capabilities: Type.Optional(
    Type.Array(StringEnum(COMPUTER_USE_TOOLS), {
      maxItems: 8,
      description: "Official Computer Use methods that must genuinely be exercised",
    }),
  ),
});

export default function codexComputerUse(pi: ExtensionAPI) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "background-computer-use");

  pi.registerCommand("background-computer-use-status", {
    description: "Show permission mode, signed Computer Use surface, audit path, and approval boundary",
    handler: async (_args, ctx) => {
      const status = await getStatus(stateRoot);
      ctx.ui.notify(JSON.stringify(status, null, 2), status.permissionMode === "full-permissions" ? "warning" : "info");
    },
  });

  pi.registerCommand("background-computer-use-mode", {
    description: "Show or explicitly change safe/default vs full-permissions mode",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const current = await loadConfig(stateRoot);
      if (!requested) {
        ctx.ui.notify(`Current Computer Use permission mode: ${current.permissionMode}`, "info");
        return;
      }
      if (requested !== "safe" && requested !== "full-permissions") {
        throw new ConfigError("Usage: /background-computer-use-mode safe|full-permissions");
      }
      if (requested === current.permissionMode) {
        ctx.ui.notify(`Computer Use permission mode is already ${requested}.`, "info");
        return;
      }
      if (requested === "full-permissions") {
        if (!ctx.hasUI) throw new ConfigError("Enabling full-permissions requires an interactive Pi UI");
        const confirmed = await ctx.ui.confirm(
          "Enable FULL Computer Use permissions?",
          "This broadly enables targeted operations that safe mode refuses. Official OpenAI/macOS approvals and signing, post-dispatch validation, lock, focus, timeout, cleanup, and audit controls remain.",
          { timeout: 60_000 },
        );
        if (!confirmed) {
          ctx.ui.notify("Full-permissions mode was not enabled.", "info");
          return;
        }
      }
      await saveConfig(stateRoot, { version: 1, permissionMode: requested });
      const record: AuditRecord = {
        timestamp: new Date().toISOString(),
        runId: crypto.randomUUID(),
        operation: "configure",
        permissionMode: requested,
        app: null,
        mutating: true,
        cleanupRequested: false,
        userConfirmed: requested === "full-permissions",
        authorization: requested === "full-permissions" ? "full_permissions_config" : "none",
        inputBytes: 0,
        outcome: "ok",
        durationMs: 0,
        model: MODEL,
        usage: { input: 0, cachedInput: 0, output: 0 },
        computerUseCalls: 0,
        backgroundPreserved: null,
        cleanupVerified: null,
      };
      try {
        await appendAudit(stateRoot, record);
      } catch {
        await saveConfig(stateRoot, current);
        throw new ConfigError("Permission mode change was rolled back because secure audit logging failed");
      }
      ctx.ui.notify(`Computer Use permission mode set to ${requested}.`, requested === "full-permissions" ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "background_computer_use",
    label: "Background Computer Use",
    description:
      "Use the official signed Codex Computer Use broker for native macOS apps. Safe mode is list-only; explicit full-permissions broadly authorizes targeted operations but never bypasses first-party approvals or technical controls. Calls consume separate Codex usage.",
    promptSnippet: "Inspect or operate a native macOS app in the background through signed Codex Computer Use",
    promptGuidelines: [
      "Use background_computer_use when the user asks to inspect or operate a native macOS app in the background.",
      "Set background_computer_use required_capabilities when the user explicitly needs click, secondary action, set value, select text, scroll, drag, keypress, or typing exercised.",
      "If background_computer_use reports a first-party approval or active app lease, do not retry automatically.",
      "Disclose that background_computer_use starts a nested Codex model call and consumes separate Codex usage.",
    ],
    parameters: Params,
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const response = await executeOperation(params, {
        stateRoot,
        signal,
        onProgress: (message) =>
          onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "running" } }),
      });
      if (response.isError) throw new Error(response.text);
      return {
        content: [{ type: "text", text: response.text }],
        details: response.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("background_computer_use ")) +
          theme.fg("accent", String(args.app ?? "apps")) +
          theme.fg("muted", ` ${String(args.mode ?? "")}`),
        0,
        0,
      );
    },
  });
}
