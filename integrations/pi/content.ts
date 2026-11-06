import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ExtensionAPI,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DirectBrokerElicitationRequest, DirectBrokerElicitationResponse } from "../../src/direct-broker.ts";
import type { JsonObject } from "../../src/tools.ts";

const jsonObjectSchema = z.record(z.string(), z.json());

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


export async function openUrl(pi: Pick<ExtensionAPI, "exec">, url: string, signal: AbortSignal | undefined): Promise<boolean> {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : ["/usr/bin/open", ["--", url]];
  return (await pi.exec(command, args, { signal, timeout: 15_000 })).code === 0;
}
