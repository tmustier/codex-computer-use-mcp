import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ElicitRequestParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type {
	DirectBrokerElicitationRequest,
	DirectBrokerElicitationResponse,
} from "./direct-broker.ts";

export interface McpElicitationClient {
	elicitInput(params: ElicitRequestParams, options?: RequestOptions): Promise<ElicitResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Forward a signed app-server elicitation over standard MCP without changing its meaning. */
export async function forwardOfficialElicitationToMcpClient(
	client: McpElicitationClient,
	request: DirectBrokerElicitationRequest,
	signal?: AbortSignal,
): Promise<DirectBrokerElicitationResponse> {
	let params: ElicitRequestParams;
	if (request.mode === "url") {
		if (
			typeof request.message !== "string"
			|| typeof request.url !== "string"
			|| typeof request.elicitationId !== "string"
		) return { action: "cancel" };
		params = {
			mode: "url",
			message: request.message,
			url: request.url,
			elicitationId: request.elicitationId,
			...(isRecord(request._meta) ? { _meta: request._meta } : {}),
		};
	} else if (request.mode === undefined || request.mode === "form") {
		if (typeof request.message !== "string" || !isRecord(request.requestedSchema)) return { action: "cancel" };
		params = {
			mode: "form",
			message: request.message,
			requestedSchema: request.requestedSchema,
			...(isRecord(request._meta) ? { _meta: request._meta } : {}),
		} as ElicitRequestParams;
	} else {
		// OpenAI's richer openai/form mode is advertised only by clients that can render it.
		return { action: "cancel" };
	}

	try {
		const response = await client.elicitInput(params, signal ? { signal } : undefined);
		return {
			action: response.action,
			...(response.content !== undefined ? { content: response.content } : {}),
			...(isRecord(response._meta) ? { _meta: response._meta } : {}),
		};
	} catch {
		// This is the MCP headless/unsupported-client outcome, not a fabricated decline.
		return { action: "cancel" };
	}
}
