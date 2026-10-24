import { z } from "zod";
import type { DirectMethod, DirectToolArguments, JsonObject, JsonValue } from "./tools.ts";
declare const elicitationRequestSchema: z.ZodObject<{
    mode: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
    requestedSchema: z.ZodOptional<z.ZodJSONSchema>;
    url: z.ZodOptional<z.ZodString>;
    elicitationId: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodJSONSchema>;
}, z.core.$catchall<z.ZodJSONSchema>>;
export type DirectBrokerElicitationRequest = z.infer<typeof elicitationRequestSchema>;
export interface DirectBrokerElicitationResponse {
    action: "accept" | "decline" | "cancel";
    content?: JsonValue;
    _meta?: JsonValue;
}
export interface DirectBrokerResult {
    content: JsonObject[];
    structuredContent?: JsonValue;
    isError: boolean;
    brokerVersion: string;
    clientBuild: string;
    elicitationRequests: number;
    modelTurnsStarted: 0;
    ephemeralThread: true;
    brokerCleanupVerified: boolean;
}
export interface DirectBrokerOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    onElicitation?: (request: DirectBrokerElicitationRequest) => DirectBrokerElicitationResponse | Promise<DirectBrokerElicitationResponse>;
    supportsOpenAiFormElicitation?: boolean;
    /** Test-only executable override. Production callers never set this. */
    appServerCommand?: string;
    /** Test-only argument override. */
    appServerArgs?: string[];
    /** Test-only signature bypass. */
    skipSignatureVerification?: boolean;
    /** Test-only client fixture, used only with skipSignatureVerification. */
    computerUseClient?: OfficialComputerUseClient;
    /** Test-only process-enumerator override. */
    processEnumeratorCommand?: string;
    onSpawn?: (pid: number) => void;
    /** Path configuration file; see `readOfficialPathConfig`. */
    configPath?: string;
}
export declare class DirectBrokerCallError extends Error {
    readonly cleanupVerified: boolean;
    readonly directCalls: number;
    readonly modelTurnsStarted: number;
    readonly ephemeralThread: boolean;
    readonly elicitationRequests: number;
    readonly brokerVersion: string;
    readonly clientBuild: string;
    constructor(message: string, cleanupVerified: boolean, cause?: unknown, evidence?: {
        directCalls?: number;
        modelTurnsStarted?: number;
        ephemeralThread?: boolean;
        elicitationRequests?: number;
        brokerVersion?: string;
        clientBuild?: string;
    });
}
interface CommandResult {
    status: number | null;
    stdout?: string;
    stderr?: string;
}
type RunSync = (command: string, args: string[]) => CommandResult;
export interface OfficialComputerUseClient {
    clientPath: string;
    appPath: string;
    layout: "installed-component" | "legacy-plugin-bundle" | "configured";
}
declare const pathConfigSchema: z.ZodObject<{
    codexPath: z.ZodOptional<z.ZodString>;
    computerUseAppPath: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type OfficialPathConfig = z.infer<typeof pathConfigSchema>;
export declare function pathConfigFile(stateRoot: string): string;
/** Read optional path overrides. A missing file means the default official locations. */
export declare function readOfficialPathConfig(configPath: string): OfficialPathConfig;
interface ResolveOfficialComputerUseClientOptions {
    /** Test-only OS-account home override. Production never reads HOME or CODEX_HOME. */
    userHome?: string;
    /** Test-only legacy root override. */
    legacyPluginRoot?: string;
    /** Test-only default Codex locations override. */
    defaultCodexPaths?: string[];
    configPath?: string;
    runSync?: RunSync;
}
/** Resolve the configured client, or else the two reviewed official layouts, preferring ChatGPT's current installed-component contract. */
export declare function resolveOfficialComputerUseClient(options?: ResolveOfficialComputerUseClientOptions): OfficialComputerUseClient;
/** Resolve the configured Codex app-server executable, or else the first default ChatGPT location that exists. */
export declare function resolveOfficialCodex(options?: ResolveOfficialComputerUseClientOptions): string;
export declare function verifyOfficialDirectBroker(options?: ResolveOfficialComputerUseClientOptions): {
    brokerVersion: string;
    clientBuild: string;
    client: OfficialComputerUseClient;
    codexPath: string;
};
export declare function buildDirectAppServerArgs(mcpCwd?: string, clientPath?: string, codexPath?: string): string[];
export interface OfficialDirectToolSession {
    call(method: DirectMethod, args: DirectToolArguments, options?: Pick<DirectBrokerOptions, "timeoutMs" | "signal" | "onElicitation">): Promise<DirectBrokerResult>;
    close(): Promise<void>;
}
export declare function createOfficialDirectToolSession(options?: DirectBrokerOptions): Promise<OfficialDirectToolSession>;
export declare function callOfficialDirectTool(method: DirectMethod, args: DirectToolArguments, options?: DirectBrokerOptions): Promise<DirectBrokerResult>;
export {};
