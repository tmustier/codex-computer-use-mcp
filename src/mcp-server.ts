#!/usr/bin/env node
import assert from "node:assert/strict";
import { Server, type ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { computerUseStatus, selectComputerUseRoute, type DirectServiceDependencies } from "./direct-service.ts";
import { forwardOfficialElicitationToMcpClient } from "./mcp-elicitation.ts";
import { LegacySessionExecutor } from "./legacy/session-executor.ts";
import { COMPUTER_USE_METHODS, isDirectMethod, TOOL_INPUT_SCHEMAS, TOOL_METADATA } from "./legacy/tools.ts";
import { DirectSessionExecutor } from "./session-executor.ts";
import { isCuaReplTool, type JsonObject } from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
	if (cliArgs.length === 1 && cliArgs[0] === "--status") {
		console.log(JSON.stringify(computerUseStatus(selectComputerUseRoute()), null, 2));
		process.exit(0);
	}
	console.error("Usage: codex-computer-use-mcp [--status]");
	process.exit(1);
}

const route = selectComputerUseRoute();
const serverOptions: ServerOptions = { capabilities: { tools: {} } };
if (route.kind === "cua_repl" && route.official.instructions) serverOptions.instructions = route.official.instructions;
const server = new Server({ name: "codex-computer-use-mcp", version: PACKAGE_VERSION }, serverOptions);
type Dependencies = Pick<DirectServiceDependencies, "signal" | "onElicitation">;
function routeTools() {
	if (route.kind === "cua_repl") {
		// agent-default (not a user rule): 2026-11-05. MCP has no turn boundary, so a quiet minute ends the turn.
		const executor = new DirectSessionExecutor({ idleTurnEndMs: 60_000 });
		return {
			definitions: route.official.tools,
			accepts: isCuaReplTool,
			call(name: string, args: JsonObject, deps: Dependencies) {
				assert(isCuaReplTool(name));
				return executor.execute(name, args, deps);
			},
			close: () => executor.close(),
		};
	}
	// Deprecated typed tools for ChatGPT without its unified runtime, with their 0.6 idle close.
	const executor = new LegacySessionExecutor({ idleTimeoutMs: 120_000 });
	return {
		definitions: COMPUTER_USE_METHODS.map((method) => ({
			name: method,
			description: TOOL_METADATA[method].description,
			inputSchema: TOOL_INPUT_SCHEMAS[method],
			annotations: TOOL_METADATA[method].annotations,
		})),
		accepts: isDirectMethod,
		call(name: string, args: JsonObject, deps: Dependencies) {
			assert(isDirectMethod(name));
			return executor.execute(name, args, deps);
		},
		close: () => executor.close(),
	};
}
const tools = routeTools();
server.onclose = () => {
	void tools.close().catch(() => { process.exitCode = 1; });
};

const statusToolDefinition = {
	name: "computer_use_status",
	title: "Computer Use Status",
	description: "Show Computer Use status.",
	inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
	tools: [...tools.definitions, statusToolDefinition],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
	if (request.params.name === statusToolDefinition.name) {
		const status = computerUseStatus(route);
		return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: status };
	}
	const name = request.params.name;
	if (!tools.accepts(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

	try {
		const args = z.record(z.string(), z.json()).parse(request.params.arguments ?? {});
		const response = await tools.call(name, args, {
			signal: extra.signal,
			onElicitation: (elicitation) => forwardOfficialElicitationToMcpClient(server, elicitation, extra.signal),
		});
		const result: CallToolResult = {
			// SAFETY: app-server returns MCP CallToolResult content blocks; the broker already verifies the JSON object envelope.
			content: response.content as CallToolResult["content"],
			isError: response.isError,
		};
		const structuredContent = z.record(z.string(), z.json()).safeParse(response.structuredContent);
		if (structuredContent.success) result.structuredContent = structuredContent.data;
		return result;
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : "Direct Computer Use failed" }],
			isError: true,
		};
	}
});

await server.connect(new StdioServerTransport());
