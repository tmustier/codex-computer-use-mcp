#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDirectStatus } from "./direct-service.ts";
import { forwardOfficialElicitationToMcpClient } from "./mcp-elicitation.ts";
import { DirectSessionExecutor } from "./session-executor.ts";
import {
	COMPUTER_USE_METHODS,
	TOOL_INPUT_SCHEMAS,
	TOOL_METADATA,
	isDirectMethod,
} from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
	if (cliArgs.length === 1 && cliArgs[0] === "--status") {
		console.log(JSON.stringify(getDirectStatus(), null, 2));
		process.exit(0);
	}
	console.error("Usage: codex-computer-use-mcp [--status]");
	process.exit(1);
}

const server = new Server(
	{ name: "codex-computer-use-mcp", version: PACKAGE_VERSION },
	{ capabilities: { tools: {} } },
);
const sessionExecutor = new DirectSessionExecutor({ idleTimeoutMs: 120_000 });
server.onclose = () => {
	void sessionExecutor.close().catch(() => { process.exitCode = 1; });
};

const toolDefinitions = COMPUTER_USE_METHODS.map((method) => ({
	name: method,
	description: TOOL_METADATA[method].description,
	inputSchema: TOOL_INPUT_SCHEMAS[method],
	annotations: TOOL_METADATA[method].annotations,
}));
const statusToolDefinition = {
	name: "computer_use_status",
	title: "Computer Use Status",
	description: "Show Computer Use status.",
	inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
	tools: [...toolDefinitions, statusToolDefinition],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
	if (request.params.name === statusToolDefinition.name) {
		const status = getDirectStatus();
		return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: status };
	}
	if (!isDirectMethod(request.params.name)) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
	}

	try {
		const args = z.record(z.string(), z.json()).parse(request.params.arguments ?? {});
		const response = await sessionExecutor.execute(request.params.name, args, {
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
