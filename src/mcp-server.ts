#!/usr/bin/env node
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendAudit, type AuditRecord } from "./audit.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { COMPUTER_USE_TOOLS, MODEL, type PermissionMode } from "./policy.ts";
import { defaultStateRoot, executeOperation, getStatus } from "./service.ts";

const version = "0.1.0";

async function handleCli(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--status") {
    console.log(JSON.stringify(await getStatus(), null, 2));
    return true;
  }
  if (args[0] !== "--configure" || (args[1] !== "safe" && args[1] !== "full-permissions")) {
    throw new Error("Usage: codex-computer-use-mcp [--status | --configure safe | --configure full-permissions --acknowledge-full-permissions]");
  }
  const requested = args[1] as PermissionMode;
  if (requested === "full-permissions" && !args.includes("--acknowledge-full-permissions")) {
    throw new Error("Refusing to enable full-permissions without --acknowledge-full-permissions. This removes wrapper app, intent, and per-operation confirmation gates; official OpenAI approvals and technical controls remain.");
  }
  const stateRoot = defaultStateRoot();
  const previous = await loadConfig(stateRoot);
  if (previous.permissionMode === requested) {
    console.log(`Permission mode is already ${requested}.`);
    return true;
  }
  await saveConfig(stateRoot, { version: 1, permissionMode: requested });
  const audit: AuditRecord = {
    timestamp: new Date().toISOString(),
    runId: crypto.randomUUID(),
    operation: "configure",
    permissionMode: requested,
    app: null,
    mutating: true,
    cleanupRequested: false,
    userConfirmed: requested === "full-permissions",
    authorization: requested === "full-permissions" ? "full_permissions_config" : "none",
    inputBytes: 0,
    outcome: "ok",
    durationMs: 0,
    model: MODEL,
    usage: { input: 0, cachedInput: 0, output: 0 },
    computerUseCalls: 0,
    backgroundPreserved: null,
    cleanupVerified: null,
  };
  try {
    await appendAudit(stateRoot, audit);
  } catch {
    await saveConfig(stateRoot, previous);
    throw new Error("Permission mode change was rolled back because secure audit logging failed");
  }
  console.log(`Permission mode set to ${requested}.`);
  return true;
}

try {
  if (await handleCli()) process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid command");
  process.exit(1);
}

const server = new McpServer(
  { name: "codex-computer-use-mcp", version },
  { capabilities: { logging: {} } },
);

const operationSchema = {
  mode: z.enum(["list", "inspect", "act", "dictionary_lookup"]).describe(
    "list discovers apps; inspect reads one app; act performs a task; dictionary_lookup is a constrained local Dictionary lookup",
  ),
  app: z.string().max(500).optional().describe("App name, bundle identifier, or app-bundle path"),
  task: z.string().max(4000).optional().describe("Concrete target-app task for act mode"),
  query: z.string().max(200).optional().describe("Local word or phrase for dictionary_lookup; never include secrets or private/customer content"),
  cleanup: z.boolean().optional().describe("Restore transient state and verify cleanup"),
  cleanup_instructions: z.string().max(2000).optional().describe("Optional cleanup postcondition"),
  required_capabilities: z.array(z.enum(COMPUTER_USE_TOOLS)).max(8).optional().describe(
    "Computer Use methods that must genuinely be exercised",
  ),
};

server.registerTool(
  "background_computer_use",
  {
    title: "Background Computer Use",
    description:
      "Inspect or operate a native macOS app in the background through the official signed Codex Computer Use broker. Safe mode blocks high-risk apps/intents and requires user elicitation for app work except narrow Dictionary lookup. Explicit full-permissions mode removes wrapper gates but never bypasses first-party OpenAI app approvals, sensitive-action prompts, macOS privacy controls, signing checks, focus telemetry, locks, timeouts, cleanup verification, or sanitized audit logging. Calls consume separate Codex usage.",
    inputSchema: operationSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args, extra): Promise<CallToolResult> => {
    try {
      const response = await executeOperation(args, {
        signal: extra.signal,
        confirm: async ({ title, body }) => {
          let elicited;
          try {
            elicited = await server.server.elicitInput({
              mode: "form",
              message: `${title}\n\n${body}`,
              requestedSchema: {
                type: "object",
                properties: {
                  confirm: {
                    type: "boolean",
                    title: "Confirm this exact background Computer Use operation",
                    description: "Enable only if the app, task, capabilities, cleanup, and separate Codex usage are intended.",
                    default: false,
                  },
                },
                required: ["confirm"],
              },
            });
          } catch {
            throw new Error(
              "Safe mode requires interactive MCP form elicitation for this app operation, but the connected client does not support it.",
            );
          }
          return elicited.action === "accept" && elicited.content?.confirm === true;
        },
      });
      return {
        content: [{ type: "text", text: response.text }],
        structuredContent: response.details,
        isError: response.isError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Computer Use failed";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "background_computer_use_status",
  {
    title: "Background Computer Use Status",
    description: "Show the server permission mode, state/audit paths, signed model, approval boundary, and supported official Computer Use methods.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (): Promise<CallToolResult> => {
    try {
      const status = await getStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : "Could not read status" }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
