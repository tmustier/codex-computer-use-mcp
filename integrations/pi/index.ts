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
import { getDirectStatus } from "../../dist/direct-service.js";
import {
  type DirectBrokerElicitationRequest,
  type DirectBrokerElicitationResponse,
} from "../../dist/direct-broker.js";
import { hostPlatform, type ComputerUsePlatform } from "../../dist/platform.js";
import { DirectSessionExecutor } from "../../dist/session-executor.js";
import { type DirectMethod, type JsonObject } from "../../dist/tools.js";

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
list_apps resolves to the official text inventory. A failed call rejects with the official error text.`,
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

const approvalPersistLabels = new Map([
  ["session", "Allow for this session"],
  ["always", "Always allow"],
]);
const approvalSchema = z.object({
  properties: z.object({ persist: z.object({ enum: z.array(z.string().min(1)).min(1) }) }),
});

/** The Windows helper asks the host to approve each app; the answer carries the chosen persistence. */
function approvalPersistOptions(request: DirectBrokerElicitationRequest): string[] | undefined {
  const meta = jsonObjectSchema.safeParse(request._meta);
  if (!meta.success || meta.data.codex_approval_kind === undefined) return undefined;
  const schema = approvalSchema.safeParse(request.requestedSchema);
  return schema.success ? schema.data.properties.persist.enum : undefined;
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
  const persistOptions = request.mode === "openai/form" ? undefined : approvalPersistOptions(request);
  if (persistOptions) {
    const labels = persistOptions.map((option) => approvalPersistLabels.get(option) ?? `Allow (${option})`);
    const choice = await ctx.ui.select(message, [...labels, "Decline", "Cancel"]);
    if (choice === "Decline") return { action: "decline" };
    const index = choice === undefined ? -1 : labels.indexOf(choice);
    if (index < 0) return { action: "cancel" };
    return { action: "accept", content: { persist: persistOptions[index] } };
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

export default function directComputerUse(
  pi: ExtensionAPI,
  session: ComputerUseSession = new DirectSessionExecutor(),
  platform: ComputerUsePlatform = hostPlatform(),
) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use");
  const toolNames = platform.methods.map(computerUseToolName);
  const namespace = computerUseNamespace(platform);
  const openUrl = async (url: string, signal: AbortSignal | undefined): Promise<boolean> => {
    const [command, args] = process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : ["/usr/bin/open", ["--", url]];
    return (await pi.exec(command, args, { signal, timeout: 15_000 })).code === 0;
  };

  pi.registerCommand("computer-use-status", {
    description: "Show Computer Use status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(getDirectStatus(stateRoot, platform), null, 2), "info");
    },
  });

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
      namespace,
      annotations: platform.metadata[method].annotations,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const args = jsonObjectSchema.parse(params);
        const response = await session.execute(method, args, {
          stateRoot,
          signal,
          platform,
          supportsOpenAiFormElicitation: true,
          onElicitation: (request) => handleOfficialElicitation(request, ctx, (url) => openUrl(url, signal)),
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
