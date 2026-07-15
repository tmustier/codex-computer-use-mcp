import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { executeDirectTool, getDirectStatus } from "../../dist/direct-service.js";
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
    description: "Show the direct-call architecture, durable no-permissions policy, signed broker, and private audit path",
    handler: async (_args, ctx) => {
      const status = await getDirectStatus(stateRoot);
      ctx.ui.notify(JSON.stringify(status, null, 2), "info");
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
        `Call computer_use_get_app_state once per assistant turn before interacting with an app.`,
      ],
      parameters: ToolParameters[method] as any,
      async execute(_toolCallId, params, signal, onUpdate) {
        const response = await executeDirectTool(
          { method, arguments: params as Record<string, unknown> },
          {
            stateRoot,
            signal,
            onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "running" } }),
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
