/**
 * Deprecated fallback: the ten typed Computer Use tools from 0.6, for ChatGPT accounts where OpenAI has
 * not turned on the unified cua_repl runtime. ChatGPT itself still uses them there. Remove this file,
 * src/legacy and test/legacy once every supported ChatGPT has the unified runtime.
 */
import type { ExtensionAPI, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { LegacySessionExecutor } from "../../src/legacy/session-executor.ts";
import {
  COMPUTER_USE_METHODS,
  TOOL_INPUT_SCHEMAS,
  TOOL_METADATA,
  type DirectMethod,
  type JsonObject,
} from "../../src/legacy/tools.ts";
import { handleOfficialElicitation, toPiContent } from "./content.ts";

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

export function computerUseToolName(method: DirectMethod): string {
  return `computer_use_${method}`;
}

const appStateOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "text", "screenshot"],
  properties: {
    app: { type: "string" },
    text: { type: "string", description: "Accessibility tree, or a diff after the first inspection" },
    screenshot: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "data", "mimeType"],
          properties: {
            type: { type: "string", const: "image" },
            data: { type: "string" },
            mimeType: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

export type LegacyComputerUseSession = Pick<LegacySessionExecutor, "execute" | "close">;

export function registerLegacyComputerUse(
  pi: ExtensionAPI,
  stateRoot: string,
  session: LegacyComputerUseSession = new LegacySessionExecutor(),
): void {
  const toolNames = COMPUTER_USE_METHODS.map(computerUseToolName);
  for (const method of COMPUTER_USE_METHODS) {
    pi.registerTool({
      name: computerUseToolName(method),
      label: `Computer Use ${method}`,
      description: TOOL_METADATA[method].description,
      // SAFETY: Pi accepts standard JSON Schema objects as custom-tool parameter schemas.
      parameters: TOOL_INPUT_SCHEMAS[method] as any,
      // SAFETY: Pi accepts standard JSON Schema objects as custom-tool output schemas.
      outputSchema: method === "get_app_state" ? appStateOutputSchema as any : undefined,
      exposure: "codemode",
      namespace: COMPUTER_USE_NAMESPACE,
      annotations: TOOL_METADATA[method].annotations,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const args = jsonObjectSchema.parse(params);
        const response = await session.execute(method, args, {
          stateRoot,
          signal,
          supportsOpenAiFormElicitation: true,
          onElicitation: (request) => handleOfficialElicitation(
            request,
            ctx,
            async (url) => (await pi.exec("/usr/bin/open", ["--", url], { signal, timeout: 15_000 })).code === 0,
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
