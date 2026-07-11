import crypto from "node:crypto";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { appendAudit, type AuditRecord } from "../../dist/audit.js";
import { ConfigError, loadConfig, saveConfig } from "../../dist/config.js";
import { executeDirectTool, getDirectStatus, type ElicitationResponse } from "../../dist/direct-service.js";
import { MUTATING_METHODS, READ_ONLY_METHODS, type DirectMethod } from "../../dist/tools.js";

const App = Type.String({ minLength: 1, maxLength: 500, description: "App name, full app path, or unambiguous bundle identifier" });
const Element = Type.String({ minLength: 1, maxLength: 200, description: "Element identifier from computer_use_get_app_state" });
const Coordinate = Type.Number({ minimum: 0, maximum: 1_000_000 });

const ToolParameters: Record<DirectMethod, TSchema> = {
  list_apps: Type.Object({}, { additionalProperties: false }),
  get_app_state: Type.Object({ app: App }, { additionalProperties: false }),
  click: Type.Object({
    app: App,
    click_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    element_index: Type.Optional(Element),
    mouse_button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
    x: Type.Optional(Coordinate),
    y: Type.Optional(Coordinate),
  }, { additionalProperties: false }),
  perform_secondary_action: Type.Object({ app: App, element_index: Element, action: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  set_value: Type.Object({ app: App, element_index: Element, value: Type.String({ maxLength: 20_000 }) }, { additionalProperties: false }),
  select_text: Type.Object({
    app: App,
    element_index: Element,
    text: Type.String({ minLength: 1, maxLength: 20_000 }),
    prefix: Type.Optional(Type.String({ maxLength: 2_000 })),
    selection: Type.Optional(StringEnum(["text", "cursor_before", "cursor_after"] as const)),
    suffix: Type.Optional(Type.String({ maxLength: 2_000 })),
  }, { additionalProperties: false }),
  scroll: Type.Object({
    app: App,
    element_index: Element,
    direction: StringEnum(["up", "down", "left", "right"] as const),
    pages: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
  }, { additionalProperties: false }),
  drag: Type.Object({ app: App, from_x: Coordinate, from_y: Coordinate, to_x: Coordinate, to_y: Coordinate }, { additionalProperties: false }),
  press_key: Type.Object({ app: App, key: Type.String({ minLength: 1, maxLength: 100, description: "Key or combination; common aliases such as CMD+A are normalized to the official xdotool-style Meta_L+a form" }) }, { additionalProperties: false }),
  type_text: Type.Object({ app: App, text: Type.String({ maxLength: 20_000 }) }, { additionalProperties: false }),
};

function toolDescription(method: DirectMethod): string {
  const mode = READ_ONLY_METHODS.has(method)
    ? "Available in safe mode."
    : "Requires explicitly acknowledged full-permissions mode.";
  return `Call the official signed Computer Use ${method} capability directly. Pi supplies the typed arguments itself; there is no nested model, planner, prompt, or separate model-token usage. ${mode}`;
}

function titleFor(method: DirectMethod): string {
  return method.split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function safePromptText(value: unknown): string {
  return String(value ?? "Official Computer Use requests confirmation.")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 4_000);
}

async function handleElicitation(request: any, ctx: ExtensionContext): Promise<ElicitationResponse> {
  if (!ctx.hasUI) return { action: "decline" };
  const mode = request?.mode;
  if (mode !== "form") {
    ctx.ui.notify("Official Computer Use requested an unsupported approval form; it was declined.", "warning");
    return { action: "decline" };
  }
  const schema = request?.requestedSchema;
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length > 8) {
    ctx.ui.notify("Official Computer Use requested an invalid approval form; it was declined.", "warning");
    return { action: "decline" };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item: unknown): item is string => typeof item === "string") : []);
  const content: Record<string, unknown> = {};
  const message = safePromptText(request.message);
  for (const [key, rawField] of Object.entries(properties as Record<string, any>)) {
    const field = rawField as any;
    const title = safePromptText(field.title ?? key);
    if (Array.isArray(field.enum) && field.enum.every((item: unknown) => typeof item === "string")) {
      const choice = await ctx.ui.select(`${message}\n${title}`, field.enum as string[]);
      if (choice === undefined) return { action: "cancel" };
      content[key] = choice;
      continue;
    }
    if (field.type === "boolean") {
      content[key] = await ctx.ui.confirm(title, message, { timeout: 60_000 });
      continue;
    }
    if (field.type === "string") {
      const value = await ctx.ui.input(`${message}\n${title}`, safePromptText(field.description ?? ""));
      if (value === undefined) return { action: "cancel" };
      if (required.has(key) && value.length === 0) return { action: "decline" };
      if (value.length > 10_000) return { action: "decline" };
      content[key] = value;
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const value = await ctx.ui.input(`${message}\n${title}`, "number");
      if (value === undefined) return { action: "cancel" };
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (field.type === "integer" && !Number.isInteger(parsed))) return { action: "decline" };
      content[key] = parsed;
      continue;
    }
    ctx.ui.notify("Official Computer Use requested an unsupported approval field; it was declined.", "warning");
    return { action: "decline" };
  }
  const accepted = await ctx.ui.confirm("Send approval response to official Computer Use?", message, { timeout: 60_000 });
  return accepted ? { action: "accept", content } : { action: "decline" };
}

function toPiContent(content: Array<Record<string, unknown>>): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const result: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === "image") {
      result.push({ type: "image", data: String(block.data), mimeType: String(block.mimeType) });
      continue;
    }
    const original = String(block.text ?? "");
    const truncated = truncateHead(original, { maxLines: 2_000, maxBytes: 50 * 1024 });
    const suffix = truncated.truncated
      ? `\n\n[Official Computer Use text truncated in-memory: ${truncated.outputLines}/${truncated.totalLines} lines, ${truncated.outputBytes}/${truncated.totalBytes} bytes. No full-output file was written.]`
      : "";
    result.push({ type: "text", text: `${truncated.content}${suffix}` });
  }
  return result;
}

function errorText(content: Array<Record<string, unknown>>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .slice(0, 2_000) || "Official Computer Use returned an error";
}

export default function directComputerUse(pi: ExtensionAPI) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use");

  pi.registerCommand("computer-use-status", {
    description: "Show the direct-call architecture, permissions, signed broker, and private audit path",
    handler: async (_args, ctx) => {
      const status = await getDirectStatus(stateRoot);
      ctx.ui.notify(JSON.stringify(status, null, 2), status.permissionMode === "full-permissions" ? "warning" : "info");
    },
  });

  pi.registerCommand("computer-use-mode", {
    description: "Show or explicitly change safe read-only vs full-permissions mode",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const current = await loadConfig(stateRoot);
      if (!requested) {
        ctx.ui.notify(`Current direct Computer Use permission mode: ${current.permissionMode}`, "info");
        return;
      }
      if (requested !== "safe" && requested !== "full-permissions") throw new ConfigError("Usage: /computer-use-mode safe|full-permissions");
      if (requested === current.permissionMode) {
        ctx.ui.notify(`Direct Computer Use permission mode is already ${requested}.`, "info");
        return;
      }
      if (requested === "full-permissions") {
        if (!ctx.hasUI) throw new ConfigError("Enabling full-permissions requires an interactive Pi UI");
        const confirmed = await ctx.ui.confirm(
          "Enable FULL direct Computer Use permissions?",
          "This enables Pi to call all eight state-changing official Computer Use methods without wrapper app/action confirmations. Official first-party approvals, signing, typed schemas, locks, focus telemetry, timeouts, cleanup, and private audits remain.",
          { timeout: 60_000 },
        );
        if (!confirmed) return;
      }
      await saveConfig(stateRoot, { version: 1, permissionMode: requested });
      const audit: AuditRecord = {
        timestamp: new Date().toISOString(), runId: crypto.randomUUID(), method: "configure", permissionMode: requested,
        app: null, mutating: true, authorization: requested === "full-permissions" ? "full_permissions_config" : "none",
        inputBytes: 0, outcome: "ok", durationMs: 0, brokerVersion: null, clientBuild: null, directCalls: 0,
        modelTurnsStarted: 0, ephemeralThread: null, approvalRequests: 0, backgroundPreserved: null,
        brokerCleanupVerified: true, resultContentTypes: [], resultBytes: 0,
      };
      try { await appendAudit(stateRoot, audit); }
      catch {
        await saveConfig(stateRoot, current);
        throw new ConfigError("Permission mode change was rolled back because secure audit logging failed");
      }
      ctx.ui.notify(`Direct Computer Use permission mode set to ${requested}.`, requested === "full-permissions" ? "warning" : "info");
    },
  });

  const methods = Object.keys(ToolParameters) as DirectMethod[];
  for (const method of methods) {
    const piName = `computer_use_${method}`;
    pi.registerTool({
      name: piName,
      label: titleFor(method),
      description: toolDescription(method),
      promptSnippet: `${titleFor(method)} through the official signed macOS Computer Use service`,
      promptGuidelines: [
        `${piName} is a direct typed tool: choose its arguments yourself; it does not invoke a nested planner or model.`,
        `${piName} must use current element identifiers from computer_use_get_app_state; inspect again after UI state changes.`,
        `${piName} must not be used for credentials, authentication, payments, external messages, or destructive actions without the user's explicit request and any first-party approval.`,
      ],
      parameters: ToolParameters[method] as any,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const response = await executeDirectTool(
          { method, arguments: params as Record<string, unknown> },
          {
            stateRoot,
            signal,
            onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "running" } }),
            onElicitation: (request) => handleElicitation(request, ctx),
          },
        );
        if (response.isError) throw new Error(errorText(response.content));
        return { content: toPiContent(response.content), details: response.details };
      },
      renderCall(args, theme) {
        const renderedArgs = args as Record<string, unknown>;
        const app = typeof renderedArgs.app === "string" ? ` ${renderedArgs.app}` : "";
        return new Text(theme.fg("toolTitle", theme.bold(`${piName} `)) + theme.fg("accent", app.trim()), 0, 0);
      },
    });
  }
}
