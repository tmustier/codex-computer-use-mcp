import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
	ElicitRequestParamsSchema,
	type ElicitRequestParams,
	type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
	DirectBrokerElicitationRequest,
	DirectBrokerElicitationResponse,
} from "./direct-broker.ts";
import type { JsonObject } from "./tools.ts";

export interface McpElicitationClient {
	elicitInput(params: ElicitRequestParams, options?: RequestOptions): Promise<ElicitResult>;
}

export async function forwardOfficialElicitationToMcpClient(
	client: McpElicitationClient,
	request: DirectBrokerElicitationRequest,
	signal?: AbortSignal,
): Promise<DirectBrokerElicitationResponse> {
	let candidate: JsonObject;
	if (request.mode === "url") {
		candidate = {
			mode: "url",
			message: request.message,
			url: request.url,
			elicitationId: request.elicitationId,
		};
	} else if (request.mode === undefined || request.mode === "form") {
		candidate = {
			mode: "form",
			message: request.message,
			requestedSchema: request.requestedSchema,
		};
	} else {
		return { action: "cancel" };
	}
	if (request._meta !== undefined) candidate._meta = request._meta;
	const parsedParams = ElicitRequestParamsSchema.safeParse(candidate);
	if (!parsedParams.success) return { action: "cancel" };

	try {
		const response = await client.elicitInput(parsedParams.data, signal ? { signal } : undefined);
		const result: DirectBrokerElicitationResponse = { action: response.action };
		const content = z.json().safeParse(response.content);
		if (content.success) result.content = content.data;
		const metadata = z.json().safeParse(response._meta);
		if (metadata.success) result._meta = metadata.data;
		return result;
	} catch {
		return { action: "cancel" };
	}
}
