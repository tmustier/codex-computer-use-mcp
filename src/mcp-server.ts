#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { executeDirectTool, getDirectStatus } from "./direct-service.ts";
import { forwardOfficialElicitationToMcpClient } from "./mcp-elicitation.ts";
import {
	EXPECTED_OFFICIAL_INPUT_SCHEMAS,
	isDirectMethod,
	OFFICIAL_METHODS,
	OFFICIAL_TOOL_METADATA,
} from "./tools.ts";

const version = "0.3.0";

async function handleCli(): Promise<boolean> {
	const args = process.argv.slice(2);
	if (args.length === 0) return false;
	if (args.length === 1 && args[0] === "--status") {
		console.log(JSON.stringify(await getDirectStatus(), null, 2));
		return true;
	}
	throw new Error("Usage: codex-computer-use-mcp [--status]. The durable no-permissions interface has no alternate mode or configuration command.");
}

try {
	if (await handleCli()) process.exit(0);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Invalid command");
	process.exit(1);
}

const server = new Server(
	{ name: "codex-computer-use-mcp", version },
	{ capabilities: { logging: {}, tools: {} } },
);

const officialToolDefinitions = OFFICIAL_METHODS.map((method) => ({
	name: method,
	description: OFFICIAL_TOOL_METADATA[method].description,
	inputSchema: EXPECTED_OFFICIAL_INPUT_SCHEMAS[method],
	annotations: OFFICIAL_TOOL_METADATA[method].annotations,
}));

const statusToolDefinition = {
	name: "computer_use_status",
	title: "Computer Use Status",
	description: "Show direct-call architecture, durable no-permissions policy, signed broker status, supported methods, and private audit path.",
	inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [...officialToolDefinitions, statusToolDefinition],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
	if (request.params.name === statusToolDefinition.name) {
		try {
			const status = await getDirectStatus();
			return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: status };
		} catch (error) {
			return { content: [{ type: "text", text: error instanceof Error ? error.message : "Could not read status" }], isError: true };
		}
	}

	if (!isDirectMethod(request.params.name)) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
	}

	try {
		const response = await executeDirectTool(
			{ method: request.params.name, arguments: request.params.arguments ?? {} },
			{
				signal: extra.signal,
				onElicitation: (elicitation) => forwardOfficialElicitationToMcpClient(server, elicitation, extra.signal),
			},
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
});

const transport = new StdioServerTransport();
await server.connect(transport);
