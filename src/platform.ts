import {
	callOfficialDirectTool,
	createOfficialDirectToolSession,
	verifyOfficialDirectBroker,
	type DirectBrokerOptions,
	type DirectBrokerResult,
	type OfficialDirectToolSession,
} from "./direct-broker.ts";
import {
	COMPUTER_USE_METHODS,
	TOOL_INPUT_SCHEMAS,
	TOOL_METADATA,
	isDirectMethod,
	validateDirectArguments,
	type DirectMethod,
	type DirectToolArguments,
	type JsonObject,
	type ToolInputSchema,
	type ToolMetadata,
} from "./tools.ts";
import {
	callOfficialWindowsTool,
	createOfficialWindowsToolSession,
	verifyOfficialWindowsBroker,
} from "./windows-sky-broker.ts";
import {
	WINDOWS_COMPUTER_USE_METHODS,
	WINDOWS_TOOL_INPUT_SCHEMAS,
	WINDOWS_TOOL_METADATA,
	isWindowsDirectMethod,
	validateWindowsArguments,
} from "./windows-tools.ts";

export type SessionOptions = Pick<DirectBrokerOptions, "configPath" | "supportsOpenAiFormElicitation">;
export type CallOptions = Pick<DirectBrokerOptions, "timeoutMs" | "signal" | "onElicitation" | "supportsOpenAiFormElicitation" | "configPath">;

/** One official Computer Use transport: macOS app-server MCP, or the Windows `@oai/sky` helper. */
export interface ComputerUsePlatform {
	readonly name: "mac" | "windows";
	readonly methods: readonly DirectMethod[];
	readonly inputSchemas: Readonly<Record<string, ToolInputSchema>>;
	readonly metadata: Readonly<Record<string, ToolMetadata>>;
	isMethod(value: string): value is DirectMethod;
	validateArguments(method: DirectMethod, value: JsonObject): DirectToolArguments;
	/** Whether a call to this method starts the retained official session. */
	opensSession(method: DirectMethod): boolean;
	createSession(options: SessionOptions): Promise<OfficialDirectToolSession>;
	callTool(method: DirectMethod, args: DirectToolArguments, options: CallOptions): Promise<DirectBrokerResult>;
	verify(configPath: string): { brokerVersion: string; clientBuild: string; codexPath?: string | undefined };
}

export const MAC_PLATFORM: ComputerUsePlatform = {
	name: "mac",
	methods: COMPUTER_USE_METHODS,
	inputSchemas: TOOL_INPUT_SCHEMAS,
	metadata: TOOL_METADATA,
	isMethod: isDirectMethod,
	validateArguments(method, value) {
		if (!isDirectMethod(method)) throw new Error(`${method} is not an official macOS Computer Use method`);
		return validateDirectArguments(method, value);
	},
	opensSession: (method) => method === "get_app_state",
	createSession: createOfficialDirectToolSession,
	callTool: callOfficialDirectTool,
	verify: (configPath) => verifyOfficialDirectBroker({ configPath }),
};

export const WINDOWS_PLATFORM: ComputerUsePlatform = {
	name: "windows",
	methods: WINDOWS_COMPUTER_USE_METHODS,
	inputSchemas: WINDOWS_TOOL_INPUT_SCHEMAS,
	metadata: WINDOWS_TOOL_METADATA,
	isMethod: isWindowsDirectMethod,
	validateArguments(method, value) {
		if (!isWindowsDirectMethod(method)) throw new Error(`${method} is not an official Windows Computer Use method`);
		return validateWindowsArguments(method, value);
	},
	// The helper has no app-state entry point; any call may start the retained session.
	opensSession: () => true,
	createSession: createOfficialWindowsToolSession,
	callTool: callOfficialWindowsTool,
	verify: (configPath) => verifyOfficialWindowsBroker({ configPath }),
};

export function hostPlatform(): ComputerUsePlatform {
	return process.platform === "win32" ? WINDOWS_PLATFORM : MAC_PLATFORM;
}
