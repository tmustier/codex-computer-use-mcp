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
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { z } from "zod";
import { getDirectStatus } from "../../dist/direct-service.js";
import {
  type DirectBrokerElicitationRequest,
  type DirectBrokerElicitationResponse,
} from "../../dist/direct-broker.js";
import { DirectSessionExecutor } from "../../dist/session-executor.js";
import {
  TOOL_INPUT_SCHEMAS,
  TOOL_METADATA,
  COMPUTER_USE_METHODS,
  type DirectMethod,
  type JsonObject,
} from "../../dist/tools.js";

const jsonObjectSchema = z.record(z.string(), z.json());
const toolNames = COMPUTER_USE_METHODS.map((method) => `computer_use_${method}`);

function titleFor(method: DirectMethod): string {
  return method.split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

interface PiContentResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  fullOutputPath?: string;
}

export async function toPiContent(content: JsonObject[]): Promise<PiContentResult> {
  const textBlocks = content
    .filter((block) => block.type !== "image")
    .map((block) => String(block.text ?? ""));
  const truncations = textBlocks.map((text) => truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  }));
  let fullOutputPath: string | undefined;
  if (truncations.some((result) => result.truncated)) {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pi-computer-use-"));
    fullOutputPath = path.join(tempDir, "output.txt");
    await writeFile(fullOutputPath, textBlocks.join("\n\n"), { encoding: "utf8", mode: 0o600 });
  }

  const result: PiContentResult = { content: [] };
  let textIndex = 0;
  for (const block of content) {
    if (block.type === "image") {
      result.content.push({ type: "image", data: String(block.data), mimeType: String(block.mimeType) });
      continue;
    }
    const truncated = truncations[textIndex++];
    const suffix = truncated.truncated
      ? `\n\n[Official Computer Use text truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output saved to: ${fullOutputPath}]`
      : "";
    result.content.push({ type: "text", text: `${truncated.content}${suffix}` });
  }
  if (fullOutputPath) result.fullOutputPath = fullOutputPath;
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

export default function directComputerUse(pi: ExtensionAPI) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use");
  const sessionExecutor = new DirectSessionExecutor();

  pi.registerCommand("computer-use-status", {
    description: "Show Computer Use status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(getDirectStatus(stateRoot), null, 2), "info");
    },
  });

  for (const method of COMPUTER_USE_METHODS) {
    const piName = `computer_use_${method}`;
    pi.registerTool({
      name: piName,
      label: titleFor(method),
      description: TOOL_METADATA[method].description,
      // SAFETY: Pi accepts standard JSON Schema objects; these schemas are generated directly from the tool's Zod parser.
      parameters: TOOL_INPUT_SCHEMAS[method] as any,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const parsedParams = jsonObjectSchema.parse(params);
        const response = await sessionExecutor.execute(method, parsedParams, {
          stateRoot,
          signal,
          supportsOpenAiFormElicitation: true,
          onElicitation: (request) => handleOfficialElicitation(
            request,
            ctx,
            async (url) => (await pi.exec("/usr/bin/open", ["--", url], { signal, timeout: 15_000 })).code === 0,
          ),
        });
        if (response.isError) {
          const message = response.content
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("\n")
            .slice(0, 2_000);
          throw new Error(message || "Official Computer Use returned an error");
        }
        const rendered = await toPiContent(response.content);
        const details: JsonObject = {};
        if (response.structuredContent !== undefined) details.officialStructuredContent = response.structuredContent;
        if (rendered.fullOutputPath) details.fullOutputPath = rendered.fullOutputPath;
        return { content: rendered.content, details };
      },
      renderCall(args, theme) {
        const parsed = z.object({ app: z.string().optional() }).safeParse(args);
        const app = parsed.success ? parsed.data.app : undefined;
        const label = theme.fg("toolTitle", theme.bold(piName));
        return new Text(app ? `${label} ${theme.fg("accent", app)}` : label, 0, 0);
      },
    });
  }

  pi.on("session_start", () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...toolNames])]));
  pi.on("agent_settled", () => sessionExecutor.close());
  pi.on("session_shutdown", () => sessionExecutor.close());
}
