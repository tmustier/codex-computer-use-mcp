import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
  type ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { getDirectStatus } from "../../src/direct-service.ts";
import {
  type DirectBrokerElicitationRequest,
  type DirectBrokerElicitationResponse,
} from "../../src/direct-broker.ts";
import { DirectSessionExecutor } from "../../src/session-executor.ts";
import {
  COMPUTER_USE_METHODS,
  TOOL_INPUT_SCHEMAS,
  TOOL_METADATA,
  type DirectMethod,
  type JsonObject,
} from "../../src/tools.ts";

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

interface PiContentResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  fullOutputPath?: string;
}

export async function toPiContent(content: JsonObject[]): Promise<PiContentResult> {
  const textBlocks = content.filter((block) => block.type !== "image").map((block) => String(block.text ?? ""));
  const fullText = textBlocks.join("\n\n");
  const aggregate = truncateHead(fullText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!aggregate.truncated) {
    return {
      content: content.map((block) => block.type === "image"
        ? { type: "image", data: String(block.data), mimeType: String(block.mimeType) }
        : { type: "text", text: String(block.text ?? "") }),
    };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "pi-computer-use-"));
  const fullOutputPath = path.join(tempDir, "output.txt");
  await writeFile(fullOutputPath, fullText, { encoding: "utf8", mode: 0o600 });
  const suffix = `\n\n[Official Computer Use text truncated: showing ${aggregate.outputLines} of ${aggregate.totalLines} lines (${formatSize(aggregate.outputBytes)} of ${formatSize(aggregate.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  const result: PiContentResult = { content: [], fullOutputPath };
  let textIndex = 0;
  let textOffset = 0;
  let noticeAdded = false;
  for (const block of content) {
    if (block.type === "image") {
      result.content.push({ type: "image", data: String(block.data), mimeType: String(block.mimeType) });
      continue;
    }
    const blockText = String(block.text ?? "");
    const start = textOffset + (textIndex > 0 ? 2 : 0);
    const end = start + blockText.length;
    const retained = aggregate.content.length > start
      ? blockText.slice(0, Math.min(end, aggregate.content.length) - start)
      : "";
    const cutoffHere: boolean = !noticeAdded && aggregate.content.length < end;
    if (retained || cutoffHere) {
      result.content.push({ type: "text", text: `${retained}${cutoffHere ? suffix : ""}` });
      noticeAdded ||= cutoffHere;
    }
    textOffset = end;
    textIndex += 1;
  }
  return result;
}

interface PiElicitationContext {
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export async function handleOfficialElicitation(
  request: DirectBrokerElicitationRequest,
  ctx: PiElicitationContext,
  openUrl: (url: string) => Promise<boolean>,
): Promise<DirectBrokerElicitationResponse> {
  if (!ctx.hasUI) return { action: "cancel" };
  const message = request.message ?? "Official Computer Use requests input";

  if (request.mode === "url") {
    if (!request.url) return { action: "cancel" };
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
  if (request.requestedSchema === undefined || (!openAiForm && !jsonObjectSchema.safeParse(request.requestedSchema).success)) {
    return { action: "cancel" };
  }
  const choice = await ctx.ui.select(message, ["Respond", "Decline", "Cancel"]);
  if (choice === "Decline") return { action: "decline" };
  if (choice !== "Respond") return { action: "cancel" };
  const title = `${message}\nSchema: ${JSON.stringify(request.requestedSchema)}`;
  let prefill = "{}";
  while (true) {
    const edited = await ctx.ui.editor(title, prefill);
    if (edited === undefined) return { action: "cancel" };
    prefill = edited;
    try {
      const parsed = JSON.parse(edited);
      const content = openAiForm ? parsed : jsonObjectSchema.parse(parsed);
      return { action: "accept", content };
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Response must be valid JSON", "error");
    }
  }
}

type ComputerUseSession = Pick<DirectSessionExecutor, "execute" | "close">;

export default function directComputerUse(pi: ExtensionAPI, session: ComputerUseSession = new DirectSessionExecutor()) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use");
  const toolNames = COMPUTER_USE_METHODS.map(computerUseToolName);

  pi.registerCommand("computer-use-status", {
    description: "Show Computer Use status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(getDirectStatus(stateRoot), null, 2), "info");
    },
  });

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
