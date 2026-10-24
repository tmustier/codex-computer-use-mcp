import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { type ElicitRequestParams, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectBrokerElicitationRequest, DirectBrokerElicitationResponse } from "./direct-broker.ts";
export interface McpElicitationClient {
    elicitInput(params: ElicitRequestParams, options?: RequestOptions): Promise<ElicitResult>;
}
export declare function forwardOfficialElicitationToMcpClient(client: McpElicitationClient, request: DirectBrokerElicitationRequest, signal?: AbortSignal): Promise<DirectBrokerElicitationResponse>;
