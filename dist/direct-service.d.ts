import { callOfficialDirectTool, type DirectBrokerElicitationRequest, type DirectBrokerElicitationResponse } from "./direct-broker.ts";
import { type DirectMethod, type JsonObject, type JsonValue } from "./tools.ts";
export interface DirectResponse {
    isError: boolean;
    content: JsonObject[];
    structuredContent?: JsonValue;
}
export interface DirectServiceDependencies {
    stateRoot?: string;
    signal?: AbortSignal;
    onElicitation?: (request: DirectBrokerElicitationRequest) => DirectBrokerElicitationResponse | Promise<DirectBrokerElicitationResponse>;
    supportsOpenAiFormElicitation?: boolean;
    callTool?: typeof callOfficialDirectTool;
}
export declare function defaultStateRoot(): string;
export declare function executeDirectTool(raw: JsonValue, deps?: DirectServiceDependencies): Promise<DirectResponse>;
interface DirectStatus extends JsonObject {
    stateRoot: string;
    permissionMode: "no-permissions";
    configPath: string;
    brokerVerified: boolean;
    brokerError?: string;
    brokerVersion?: string;
    clientBuild?: string;
    codexPath?: string;
    methods: DirectMethod[];
}
export declare function getDirectStatus(stateRoot?: string): DirectStatus;
export {};
