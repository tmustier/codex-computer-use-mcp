import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { executeDirectTool, getDirectStatus } from "../../dist/direct-service.js";
import type { DirectMethod } from "../../dist/tools.js";

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
  return `Call the official signed Computer Use ${method} capability directly through the unrestricted no-permissions interface. Pi supplies the typed arguments itself; there is no wrapper approval prompt, mode gate, nested model, planner, prompt, or separate model-token usage.`;
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
        `${piName} must use current element identifiers from computer_use_get_app_state; inspect again after UI state changes.`,
        `${piName} must not be used for credentials, authentication, payments, external messages, or destructive actions without the user's explicit request; this wrapper will not open a permission prompt.`,
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
