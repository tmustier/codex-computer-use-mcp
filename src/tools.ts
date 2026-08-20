import { z } from "zod";

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

const app = z.string().describe("App name, full app path, or unambiguous bundle identifier");
const selectTextApp = z.string().describe("App name or bundle identifier");
const additionalArgument = z.json();

export const COMPUTER_USE_METHODS = [
	"list_apps",
	"get_app_state",
	"click",
	"perform_secondary_action",
	"set_value",
	"select_text",
	"scroll",
	"drag",
	"press_key",
	"type_text",
] as const;

export type DirectMethod = typeof COMPUTER_USE_METHODS[number];
export type DirectToolArguments = JsonObject;

const DIRECT_TOOL_SCHEMAS = {
	list_apps: z.object({}).catchall(additionalArgument),
	get_app_state: z.object({ app }).catchall(additionalArgument),
	click: z.object({
		app,
		click_count: z.number().int().describe("Number of clicks. Defaults to 1").optional(),
		element_index: z.string().describe("Element index to click").optional(),
		mouse_button: z.enum(["left", "right", "middle"]).describe("Mouse button to click. Defaults to left.").optional(),
		x: z.number().describe("X coordinate in screenshot pixel coordinates").optional(),
		y: z.number().describe("Y coordinate in screenshot pixel coordinates").optional(),
	}).catchall(additionalArgument),
	perform_secondary_action: z.object({
		app,
		element_index: z.string().describe("Element identifier"),
		action: z.string().describe("Secondary accessibility action name"),
	}).catchall(additionalArgument),
	set_value: z.object({
		app,
		element_index: z.string().describe("Element identifier"),
		value: z.string().describe("Value to assign"),
	}).catchall(additionalArgument),
	select_text: z.object({
		app: selectTextApp,
		element_index: z.string().describe("Text element identifier"),
		text: z.string().describe("Target text as shown in the accessibility tree"),
		prefix: z.string().describe("Optional text immediately before the target, used to disambiguate repeated matches").optional(),
		selection: z.enum(["text", "cursor_before", "cursor_after"]).describe("Whether to select the text or place the cursor before or after it. Defaults to text.").optional(),
		suffix: z.string().describe("Optional text immediately after the target, used to disambiguate repeated matches").optional(),
	}).catchall(additionalArgument),
	scroll: z.object({
		app,
		element_index: z.string().describe("Element identifier"),
		direction: z.string().describe("Scroll direction: up, down, left, or right"),
		pages: z.number().describe("Number of pages to scroll. Fractional values are supported. Defaults to 1").optional(),
	}).catchall(additionalArgument),
	drag: z.object({
		app,
		from_x: z.number().describe("Start X coordinate"),
		from_y: z.number().describe("Start Y coordinate"),
		to_x: z.number().describe("End X coordinate"),
		to_y: z.number().describe("End Y coordinate"),
	}).catchall(additionalArgument),
	press_key: z.object({ app, key: z.string().describe("Key or key combination to press") }).catchall(additionalArgument),
	type_text: z.object({ app, text: z.string().describe("Literal text to type") }).catchall(additionalArgument),
} satisfies Record<DirectMethod, z.ZodType>;

interface ToolMetadata {
	description: string;
	annotations: {
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
		readOnlyHint: boolean;
	};
}

const readAnnotations = {
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	readOnlyHint: true,
} as const;
const actionAnnotations = {
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
	readOnlyHint: false,
} as const;

export const TOOL_METADATA = {
	list_apps: {
		description: "List the apps on this computer. Returns the set of apps that are currently running, as well as any that have been used in the last 14 days, including details on usage frequency",
		annotations: readAnnotations,
	},
	get_app_state: {
		description: "Start an app use session if needed, then get the state of the app's key window and return a screenshot and accessibility tree. This must be called once per assistant turn before interacting with the app",
		annotations: readAnnotations,
	},
	click: {
		description: "Click an element by index or pixel coordinates from screenshot",
		annotations: actionAnnotations,
	},
	perform_secondary_action: {
		description: "Invoke a secondary accessibility action exposed by an element",
		annotations: actionAnnotations,
	},
	set_value: {
		description: "Set the value of a settable accessibility element",
		annotations: actionAnnotations,
	},
	select_text: {
		description: "Select text inside a text element, or place the text cursor before or after it. Provide text exactly as it appears in the accessibility tree, including any Markdown formatting. If the text is not unique, provide surrounding prefix or suffix text to disambiguate it.",
		annotations: actionAnnotations,
	},
	scroll: {
		description: "Scroll an element in a direction by a number of pages",
		annotations: actionAnnotations,
	},
	drag: {
		description: "Drag from one point to another using pixel coordinates",
		annotations: actionAnnotations,
	},
	press_key: {
		description: "Press a key or key-combination on the keyboard, including modifier and navigation keys. This supports xdotool's `key` syntax, for example `a`, `Return`, `super+c`, `Up`, or `KP_0`.",
		annotations: actionAnnotations,
	},
	type_text: {
		description: "Type literal text using keyboard input",
		annotations: actionAnnotations,
	},
} satisfies Record<DirectMethod, ToolMetadata>;

const methodNames = new Set<string>(COMPUTER_USE_METHODS);

export function isDirectMethod(value: string): value is DirectMethod {
	return methodNames.has(value);
}

export function validateDirectArguments(method: DirectMethod, value: JsonObject): DirectToolArguments {
	return DIRECT_TOOL_SCHEMAS[method].parse(value);
}

function inputSchema(schema: z.ZodType) {
	const { $schema: _schema, ...result } = z.toJSONSchema(schema);
	return result;
}

export const TOOL_INPUT_SCHEMAS = {
	list_apps: inputSchema(DIRECT_TOOL_SCHEMAS.list_apps),
	get_app_state: inputSchema(DIRECT_TOOL_SCHEMAS.get_app_state),
	click: inputSchema(DIRECT_TOOL_SCHEMAS.click),
	perform_secondary_action: inputSchema(DIRECT_TOOL_SCHEMAS.perform_secondary_action),
	set_value: inputSchema(DIRECT_TOOL_SCHEMAS.set_value),
	select_text: inputSchema(DIRECT_TOOL_SCHEMAS.select_text),
	scroll: inputSchema(DIRECT_TOOL_SCHEMAS.scroll),
	drag: inputSchema(DIRECT_TOOL_SCHEMAS.drag),
	press_key: inputSchema(DIRECT_TOOL_SCHEMAS.press_key),
	type_text: inputSchema(DIRECT_TOOL_SCHEMAS.type_text),
} satisfies Record<DirectMethod, ReturnType<typeof inputSchema>>;
