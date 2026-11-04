import { z } from "zod";

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

/** The official cua_repl tools a caller may invoke. `turn_ended` is sent by the adapter at each turn's end. */
export const CUA_REPL_TOOLS = ["js", "js_reset"] as const;
export type CuaReplTool = typeof CUA_REPL_TOOLS[number];
export type CuaReplArguments = JsonObject;

const cuaReplToolSchema = z.enum(CUA_REPL_TOOLS);

export function isCuaReplTool(value: string): value is CuaReplTool {
	return cuaReplToolSchema.safeParse(value).success;
}

interface JsProperties {
	code: JsonObject;
	completion_summary?: JsonObject;
	timeout_ms: JsonObject;
	title: JsonObject;
}

export interface CuaReplToolDefinition {
	name: CuaReplTool;
	description: string;
	inputSchema: {
		type: "object";
		properties: Partial<JsProperties>;
		additionalProperties: false;
	};
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

export interface CuaReplToolSet {
	instructions?: string;
	tools: CuaReplToolDefinition[];
}

const overridesSchema = z.object({
	server_instructions: z.string().optional(),
	tools: z.object({
		js: z.object({
			description: z.string(),
			field_descriptions: z.object({ code: z.string(), title: z.string() }),
		}),
		js_reset: z.object({ description: z.string() }),
	}),
});
const completionSchema = z.object({ instructions: z.string(), description: z.string() });

const TIMEOUT_DESCRIPTION = "Optional execution timeout in milliseconds. Defaults to 30000 (30 seconds) when omitted.";
// The annotations official node_repl reports for both tools.
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/**
 * Build the tool definitions that official node_repl derives from ChatGPT's cua_repl environment.
 * They match its tools/list output except for the top-level `oneOf`, which some model providers
 * reject; node_repl still enforces it.
 */
export function cuaReplToolDefinitions(env: Record<string, string>): CuaReplToolSet {
	const overrides = overridesSchema.parse(JSON.parse(env.NODE_REPL_TOOL_OVERRIDES ?? "null"));
	const completion = env.NODE_REPL_JS_COMPLETION_SUMMARY ? completionSchema.parse(JSON.parse(env.NODE_REPL_JS_COMPLETION_SUMMARY)) : undefined;
	const { code, title } = overrides.tools.js.field_descriptions;
	const properties: JsProperties = {
		code: { description: code, type: "string" },
		timeout_ms: { description: TIMEOUT_DESCRIPTION, minimum: 1, type: "integer" },
		title: { description: title, maxLength: 80, minLength: 1, type: "string" },
	};
	if (completion) properties.completion_summary = { description: completion.description, maxLength: 80, minLength: 1, type: "string" };
	return {
		instructions: overrides.server_instructions,
		tools: [
			{
				name: "js",
				description: completion ? `${overrides.tools.js.description}\n\n${completion.instructions}` : overrides.tools.js.description,
				inputSchema: { type: "object", properties, additionalProperties: false },
				annotations: ANNOTATIONS,
			},
			{
				name: "js_reset",
				description: overrides.tools.js_reset.description,
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				annotations: ANNOTATIONS,
			},
		],
	};
}
