import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { executeDirectTool, getDirectStatus } from "../../dist/direct-service.js";
import type {
  DirectBrokerElicitationRequest,
  DirectBrokerElicitationResponse,
} from "../../dist/direct-broker.js";
import { OFFICIAL_TOOL_METADATA, type DirectMethod } from "../../dist/tools.js";

const App = Type.String({ description: "App name, full app path, or unambiguous bundle identifier" });

const ToolParameters: Record<DirectMethod, TSchema> = {
  list_apps: Type.Object({}, { additionalProperties: false }),
  get_app_state: Type.Object({ app: App }, { additionalProperties: false }),
  click: Type.Object({
    app: App,
    click_count: Type.Optional(Type.Integer({ description: "Number of clicks. Defaults to 1" })),
    element_index: Type.Optional(Type.String({ description: "Element index to click" })),
    mouse_button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "Mouse button to click. Defaults to left." })),
    x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixel coordinates" })),
    y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixel coordinates" })),
  }, { additionalProperties: false }),
  perform_secondary_action: Type.Object({
    app: App,
    element_index: Type.String({ description: "Element identifier" }),
    action: Type.String({ description: "Secondary accessibility action name" }),
  }, { additionalProperties: false }),
  set_value: Type.Object({
    app: App,
    element_index: Type.String({ description: "Element identifier" }),
    value: Type.String({ description: "Value to assign" }),
  }, { additionalProperties: false }),
  select_text: Type.Object({
    app: Type.String({ description: "App name or bundle identifier" }),
    element_index: Type.String({ description: "Text element identifier" }),
    text: Type.String({ description: "Target text as shown in the accessibility tree" }),
    prefix: Type.Optional(Type.String({ description: "Optional text immediately before the target, used to disambiguate repeated matches" })),
    selection: Type.Optional(StringEnum(["text", "cursor_before", "cursor_after"] as const, { description: "Whether to select the text or place the cursor before or after it. Defaults to text." })),
    suffix: Type.Optional(Type.String({ description: "Optional text immediately after the target, used to disambiguate repeated matches" })),
  }, { additionalProperties: false }),
  scroll: Type.Object({
    app: App,
    element_index: Type.String({ description: "Element identifier" }),
    direction: Type.String({ description: "Scroll direction: up, down, left, or right" }),
    pages: Type.Optional(Type.Number({ description: "Number of pages to scroll. Fractional values are supported. Defaults to 1" })),
  }, { additionalProperties: false }),
  drag: Type.Object({
    app: App,
    from_x: Type.Number({ description: "Start X coordinate" }),
    from_y: Type.Number({ description: "Start Y coordinate" }),
    to_x: Type.Number({ description: "End X coordinate" }),
    to_y: Type.Number({ description: "End Y coordinate" }),
  }, { additionalProperties: false }),
  press_key: Type.Object({ app: App, key: Type.String({ description: "Key or key combination to press" }) }, { additionalProperties: false }),
  type_text: Type.Object({ app: App, text: Type.String({ description: "Literal text to type" }) }, { additionalProperties: false }),
};

function toolDescription(method: DirectMethod): string {
  return OFFICIAL_TOOL_METADATA[method].description;
}

function titleFor(method: DirectMethod): string {
  return method.split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

const INSPECTION_METHODS = new Set<DirectMethod>(["list_apps", "get_app_state"]);
export const INSPECTION_TOOL_NAMES = [
  "computer_use_list_apps",
  "computer_use_get_app_state",
] as const;
export const INTERACTION_TOOL_NAMES = [
  "computer_use_click",
  "computer_use_perform_secondary_action",
  "computer_use_set_value",
  "computer_use_select_text",
  "computer_use_scroll",
  "computer_use_drag",
  "computer_use_press_key",
  "computer_use_type_text",
] as const;

export function setInitialComputerUseTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
  const interactionTools = new Set<string>(INTERACTION_TOOL_NAMES);
  const preserved = pi.getActiveTools().filter((name) => !interactionTools.has(name));
  pi.setActiveTools([...new Set([...preserved, ...INSPECTION_TOOL_NAMES])]);
}

export function activateInteractionTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
  const active = pi.getActiveTools();
  pi.setActiveTools([...new Set([...active, ...INTERACTION_TOOL_NAMES])]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function initialFormContent(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  const content: Record<string, unknown> = {};
  for (const [key, rawProperty] of Object.entries(schema.properties)) {
    if (!isRecord(rawProperty)) continue;
    if (rawProperty.default !== undefined) content[key] = rawProperty.default;
    else if (Array.isArray(rawProperty.enum) && rawProperty.enum.length > 0) content[key] = rawProperty.enum[0];
    else if (rawProperty.type === "boolean") content[key] = false;
    else if (rawProperty.type === "number" || rawProperty.type === "integer") content[key] = 0;
    else if (rawProperty.type === "array") content[key] = [];
    else content[key] = "";
  }
  return content;
}

export async function handleOfficialElicitation(
  request: DirectBrokerElicitationRequest,
  ctx: { hasUI: boolean; ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  } },
  openUrl: (url: string) => Promise<boolean>,
): Promise<DirectBrokerElicitationResponse> {
  if (!ctx.hasUI) return { action: "cancel" };
  const message = typeof request.message === "string" ? request.message : "Official Computer Use requests input";

  if (request.mode === "url") {
    if (typeof request.url !== "string") return { action: "cancel" };
    const choice = await ctx.ui.select(`${message}\n${request.url}`, ["Open URL", "Decline", "Cancel"]);
    if (choice === "Decline") return { action: "decline" };
    if (choice !== "Open URL") return { action: "cancel" };
    if (!await openUrl(request.url)) {
      ctx.ui.notify("Could not open the official Computer Use URL.", "error");
      return { action: "cancel" };
    }
    return { action: "accept" };
  }

  if (request.mode !== undefined && request.mode !== "form" && request.mode !== "openai/form") {
    ctx.ui.notify(`Official Computer Use sent an unsupported elicitation mode: ${request.mode}`, "warning");
    return { action: "cancel" };
  }
  const openAiForm = request.mode === "openai/form";
  if (request.requestedSchema === undefined || (!openAiForm && !isRecord(request.requestedSchema))) return { action: "cancel" };
  const choice = await ctx.ui.select(message, ["Respond", "Decline", "Cancel"]);
  if (choice === "Decline") return { action: "decline" };
  if (choice !== "Respond") return { action: "cancel" };
  let prefill = JSON.stringify(initialFormContent(request.requestedSchema), null, 2);
  const title = `${message}\nSchema: ${JSON.stringify(request.requestedSchema)}`;
  while (true) {
    const edited = await ctx.ui.editor(title, prefill);
    if (edited === undefined) return { action: "cancel" };
    prefill = edited;
    try {
      const content = JSON.parse(edited);
      if (!openAiForm && !isRecord(content)) throw new Error("Response must be a JSON object");
      return { action: "accept", content };
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Response must be valid JSON", "error");
    }
  }
}

export default function directComputerUse(pi: ExtensionAPI) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use");

  pi.registerCommand("computer-use-status", {
    description: "Show the direct-call architecture, durable no-permissions policy, signed broker, and private audit path",
    handler: async (_args, ctx) => {
      const status = await getDirectStatus(stateRoot);
      ctx.ui.notify(JSON.stringify(status, null, 2), "info");
    },
  });

  const methods = Object.keys(ToolParameters) as DirectMethod[];
  for (const method of methods) {
    const piName = `computer_use_${method}`;
    const inspectionPromptMetadata = INSPECTION_METHODS.has(method) ? {
      promptSnippet: `${titleFor(method)} through the official signed macOS Computer Use service`,
      promptGuidelines: [
        `${piName} is a direct typed tool: choose its arguments yourself; it does not invoke a nested planner or model.`,
        `Call computer_use_get_app_state once per assistant turn before interacting with an app.`,
      ],
    } : {};
    pi.registerTool({
      name: piName,
      label: titleFor(method),
      description: toolDescription(method),
      ...inspectionPromptMetadata,
      parameters: ToolParameters[method] as any,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const response = await executeDirectTool(
          { method, arguments: params as Record<string, unknown> },
          {
            stateRoot,
            signal,
            supportsOpenAiFormElicitation: true,
            onElicitation: (request) => handleOfficialElicitation(
              request,
              ctx,
              async (url) => {
                const result = await pi.exec("/usr/bin/open", ["--", url], { signal, timeout: 15_000 });
                return result.code === 0;
              },
            ),
            onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "running" } }),
          },
        );
        if (response.isError) throw new Error(errorText(response.content));
        if (method === "get_app_state") activateInteractionTools(pi);
        return { content: toPiContent(response.content), details: response.details };
      },
      renderCall(args, theme) {
        const renderedArgs = args as Record<string, unknown>;
        const app = typeof renderedArgs.app === "string" ? ` ${renderedArgs.app}` : "";
        return new Text(theme.fg("toolTitle", theme.bold(`${piName} `)) + theme.fg("accent", app.trim()), 0, 0);
      },
    });
  }

  pi.on("session_start", () => setInitialComputerUseTools(pi));
}
