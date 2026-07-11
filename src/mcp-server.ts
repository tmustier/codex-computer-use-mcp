#!/usr/bin/env node
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { appendAudit, type AuditRecord } from "./audit.ts";
import { loadConfig, saveConfig, type PermissionMode } from "./config.ts";
import { executeDirectTool, getDirectStatus, defaultStateRoot } from "./direct-service.ts";
import {
	DIRECT_TOOL_SCHEMAS,
	MUTATING_METHODS,
	OFFICIAL_METHODS,
	READ_ONLY_METHODS,
	type DirectMethod,
} from "./tools.ts";

const version = "0.2.0";

async function handleCli(): Promise<boolean> {
	const args = process.argv.slice(2);
	if (args.length === 0) return false;
	if (args.length === 1 && args[0] === "--status") {
		console.log(JSON.stringify(await getDirectStatus(), null, 2));
		return true;
	}
	if (args[0] !== "--configure" || (args[1] !== "safe" && args[1] !== "full-permissions")) {
		throw new Error("Usage: codex-computer-use-mcp [--status | --configure safe | --configure full-permissions --acknowledge-full-permissions]");
	}
	const requested = args[1] as PermissionMode;
	if (requested === "full-permissions" && !args.includes("--acknowledge-full-permissions")) {
		throw new Error("Refusing to enable full-permissions without --acknowledge-full-permissions. This enables all eight state-changing official Computer Use tools without wrapper app/action confirmation; first-party approvals and technical controls remain.");
	}
	const stateRoot = defaultStateRoot();
	const previous = await loadConfig(stateRoot);
	if (previous.permissionMode === requested) {
		console.log(`Permission mode is already ${requested}.`);
		return true;
	}
	await saveConfig(stateRoot, { version: 1, permissionMode: requested });
	const audit: AuditRecord = {
		timestamp: new Date().toISOString(), runId: crypto.randomUUID(), method: "configure", permissionMode: requested,
		app: null, mutating: true, authorization: requested === "full-permissions" ? "full_permissions_config" : "none",
		inputBytes: 0, outcome: "ok", durationMs: 0, brokerVersion: null, clientBuild: null, directCalls: 0,
		modelTurnsStarted: 0, ephemeralThread: null, approvalRequests: 0, backgroundPreserved: null,
		brokerCleanupVerified: true, resultContentTypes: [], resultBytes: 0,
	};
	try { await appendAudit(stateRoot, audit); }
	catch {
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

function titleFor(method: DirectMethod): string {
	return method.split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function descriptionFor(method: DirectMethod): string {
	const authorization = READ_ONLY_METHODS.has(method)
		? "Available in safe mode."
		: "Requires explicitly acknowledged full-permissions mode.";
	return `Call the official signed Computer Use ${method} capability directly. Pi/the MCP client supplies the typed arguments; no nested model, prompt, planner, or model-token usage is involved. ${authorization}`;
}

for (const method of OFFICIAL_METHODS) {
	server.registerTool(
		method,
		{
			title: titleFor(method),
			description: descriptionFor(method),
			inputSchema: DIRECT_TOOL_SCHEMAS[method],
			annotations: {
				readOnlyHint: READ_ONLY_METHODS.has(method),
				destructiveHint: MUTATING_METHODS.has(method),
				idempotentHint: method === "list_apps" || method === "get_app_state",
				openWorldHint: false,
			},
		},
		async (toolArgs: Record<string, unknown>, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
			try {
				const response = await executeDirectTool(
					{ method, arguments: toolArgs },
					{ signal: extra.signal },
				);
				return {
					content: response.content as ContentBlock[],
					structuredContent: response.details,
					isError: response.isError,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : "Direct Computer Use failed" }],
					isError: true,
				};
			}
		},
	);
}

server.registerTool(
	"computer_use_status",
	{
		title: "Computer Use Status",
		description: "Show direct-call architecture, permission mode, signed broker status, supported methods, and private audit path.",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	async (): Promise<CallToolResult> => {
		try {
			const status = await getDirectStatus();
			return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: status };
		} catch (error) {
			return { content: [{ type: "text", text: error instanceof Error ? error.message : "Could not read status" }], isError: true };
		}
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
