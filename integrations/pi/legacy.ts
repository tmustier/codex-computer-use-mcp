/**
 * Deprecated fallback: the ten typed Computer Use tools from 0.6, for ChatGPT accounts where OpenAI has
 * not turned on the unified cua_repl runtime. ChatGPT itself still uses them there. Remove this file,
 * src/legacy and test/legacy once every supported ChatGPT has the unified runtime.
 */
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { LegacySessionExecutor } from "../../src/legacy/session-executor.ts";
import { hostPlatform, type ComputerUsePlatform } from "../../src/legacy/platform.ts";
import type { DirectMethod, JsonObject } from "../../src/legacy/tools.ts";
import { handleOfficialElicitation, openUrl, toPiContent } from "./content.ts";

const jsonObjectSchema = z.record(z.string(), z.json());

export const COMPUTER_USE_NAMESPACE: ToolNamespace = {
  name: "computer_use",
  description: "OpenAI's official signed macOS Computer Use. Call get_app_state for an app before acting on it, run known actions in sequence, then call get_app_state again before deciding the next step.",
  instructions: `Compose these tools in codemode scripts:

const state = await tools.computer_use_get_app_state({ app: "TextEdit" });
text(state.text);
image(state.screenshot);
await tools.computer_use_click({ app: "TextEdit", element_index: "7" });
await tools.computer_use_type_text({ app: "TextEdit", text: "hello" });

get_app_state resolves to { app, text, screenshot }. text is the accessibility tree; after the first inspection it may be a diff, so pass disableDiff: true for a fresh full tree. screenshot is an image block for image(), or null.
Take element_index values from the latest get_app_state text, and inspect again after acting.
Calls run one at a time, in the order the script makes them.
list_apps resolves to the official text inventory. A failed call rejects with the official error text. When the adapter recognises the cause, the error also gives a recovery step; follow it before falling back to other tools, and tell the user if it still fails.`,
};

export const WINDOWS_COMPUTER_USE_NAMESPACE: ToolNamespace = {
  name: "computer_use",
  description: "OpenAI's official signed Windows Computer Use. Pick a window from list_apps or list_windows, call get_window_state for it before acting, run known actions in sequence, then call get_window_state again before deciding the next step.",
  instructions: `Compose these tools in codemode scripts:

const { apps } = await tools.computer_use_list_apps({});
const window = apps.find((app) => app.displayName === "Notepad")?.windows[0];
const state = await tools.computer_use_get_window_state({ window, include_text: true });
text(state.accessibility?.tree ?? "");
for (const shot of state.screenshots) if (shot.image) image(shot.image);
await tools.computer_use_click({ window, element_index: 7 });
await tools.computer_use_type_text({ window, text: "hello" });

list_apps resolves to { apps } and list_windows to { windows }. A window is { app, id, title }; pass it unchanged as the window argument of later calls, and use launch_app for an app without an open window.
get_window_state resolves to { window, accessibility, screenshots }. accessibility.tree is the indexed element tree when include_text is true; each screenshot carries an image block for image() plus its id, size and origin. Take element_index values from the latest get_window_state, and inspect again after acting.
scroll takes a window-relative x, y start point and scrollX, scrollY deltas. press_key uses keysym names such as Return, Tab or Control_L+a.
Calls run one at a time, in the order the script makes them. The first use of an app asks for approval in Pi. A failed call rejects with the official error text.
Computer Use holds the desktop during a turn, which ends when the agent settles or after 15 s without calls; element indexes are valid within one turn, so inspect again before acting after a pause.`,
};

export function computerUseNamespace(platform: ComputerUsePlatform): ToolNamespace {
  return platform.name === "windows" ? WINDOWS_COMPUTER_USE_NAMESPACE : COMPUTER_USE_NAMESPACE;
}

export function computerUseToolName(method: DirectMethod): string {
  return `computer_use_${method}`;
}

const imageBlockSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "data", "mimeType"],
  properties: {
    type: { type: "string", const: "image" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
} as const;

const appStateOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "text", "screenshot"],
  properties: {
    app: { type: "string" },
    text: { type: "string", description: "Accessibility tree, or a diff after the first inspection" },
    screenshot: { anyOf: [imageBlockSchema, { type: "null" }] },
  },
} as const;

const windowSchema = {
  type: "object",
  required: ["app", "id"],
  properties: {
    app: { type: "string", description: "App identifier that owns the window" },
    id: { type: "integer", description: "Opaque window identifier" },
    title: { type: "string" },
  },
} as const;

const windowStateOutputSchema = {
  type: "object",
  required: ["window", "accessibility", "screenshots"],
  properties: {
    window: windowSchema,
    accessibility: {
      anyOf: [
        {
          type: "object",
          required: ["tree"],
          properties: {
            tree: { type: "string", description: "Indexed accessibility tree" },
            focused_element: { type: "string" },
            selected_text: { type: "string" },
            selected_elements: { type: "array", items: { type: "string" } },
            document_text: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    screenshots: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "image"],
        properties: {
          id: { type: "string" },
          zIndex: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          originX: { type: "number" },
          originY: { type: "number" },
          image: { anyOf: [imageBlockSchema, { type: "null" }] },
        },
      },
    },
  },
} as const;

const appListOutputSchema = {
  type: "object",
  required: ["apps"],
  properties: {
    apps: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string" },
          isRunning: { type: "boolean" },
          lastUsedDate: { type: "string" },
          useCount: { type: "number" },
          windows: { type: "array", items: windowSchema },
        },
      },
    },
  },
} as const;

const windowListOutputSchema = {
  type: "object",
  required: ["windows"],
  properties: { windows: { type: "array", items: windowSchema } },
} as const;

const windowOutputSchema = {
  type: "object",
  required: ["window"],
  properties: { window: windowSchema },
} as const;

function outputSchemaFor(platform: ComputerUsePlatform, method: DirectMethod): object | undefined {
  if (platform.name !== "windows") return method === "get_app_state" ? appStateOutputSchema : undefined;
  switch (method) {
    case "get_window_state": return windowStateOutputSchema;
    case "list_apps": return appListOutputSchema;
    case "list_windows": return windowListOutputSchema;
    case "get_window": return windowOutputSchema;
    default: return undefined;
  }
}

export type LegacyComputerUseSession = Pick<LegacySessionExecutor, "execute" | "close">;

export function registerLegacyComputerUse(
  pi: ExtensionAPI,
  stateRoot: string,
  session: LegacyComputerUseSession = new LegacySessionExecutor(),
  platform: ComputerUsePlatform = hostPlatform(),
): void {
  const toolNames = platform.methods.map(computerUseToolName);
  for (const method of platform.methods) {
    const outputSchema = outputSchemaFor(platform, method);
    pi.registerTool({
      name: computerUseToolName(method),
      label: `Computer Use ${method}`,
      description: platform.metadata[method].description,
      // SAFETY: Pi accepts standard JSON Schema objects as custom-tool parameter schemas.
      parameters: platform.inputSchemas[method] as any,
      // SAFETY: Pi accepts standard JSON Schema objects as custom-tool output schemas.
      outputSchema: outputSchema as any,
      exposure: "codemode",
      namespace: computerUseNamespace(platform),
      annotations: platform.metadata[method].annotations,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const args = jsonObjectSchema.parse(params);
        const response = await session.execute(method, args, {
          stateRoot,
          platform,
          signal,
          supportsOpenAiFormElicitation: true,
          onElicitation: (request) => handleOfficialElicitation(
            request,
            ctx,
            (url) => openUrl(pi, url, signal),
          ),
        });
        const text = response.content
          .filter((block) => block.type !== "image")
          .map((block) => String(block.text ?? ""))
          .join("\n");
        if (response.isError) throw new Error(text || "Official Computer Use returned an error");
        const rendered = await toPiContent(response.content);
        const details: JsonObject = {};
        if (rendered.fullOutputPath) details.fullOutputPath = rendered.fullOutputPath;
        if (platform.name === "windows") {
          // The official JavaScript result is already the structured value.
          const structured = jsonObjectSchema.safeParse(response.structuredContent);
          return outputSchema && structured.success
            ? { content: rendered.content, details, structuredContent: structured.data }
            : { content: rendered.content, details };
        }
        if (method !== "get_app_state") return { content: rendered.content, details };
        const screenshot = response.content.find((block) => block.type === "image");
        return {
          content: rendered.content,
          details,
          structuredContent: {
            app: String(args.app),
            text,
            screenshot: screenshot
              ? { type: "image", data: String(screenshot.data), mimeType: String(screenshot.mimeType) }
              : null,
          },
        };
      },
    });
  }

  let reachabilityChecked = false;
  pi.on("session_start", () => { reachabilityChecked = false; });
  pi.on("before_agent_start", (_event, ctx) => {
    if (reachabilityChecked) return;
    reachabilityChecked = true;
    const active = pi.getActiveTools();
    if (active.includes("codemode") || toolNames.some((name) => active.includes(name))) return;
    ctx.ui.notify(
      "Computer Use tools are called from codemode, which is not active. Add \"+codemode\" to defaultTools in settings.json, or start Pi with --tools +codemode.",
      "warning",
    );
  });
  pi.on("agent_settled", () => session.close());
  pi.on("session_shutdown", () => session.close());
}
