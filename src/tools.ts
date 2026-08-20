import { z } from "zod";

const app = z.string().describe("App name, full app path, or unambiguous bundle identifier");
const selectTextApp = z.string().describe("App name or bundle identifier");

export const DIRECT_TOOL_SCHEMAS = {
	list_apps: z.object({}).passthrough(),
	get_app_state: z.object({ app }).passthrough(),
	click: z
		.object({
			app,
			click_count: z.number().refine(Number.isInteger).describe("Number of clicks. Defaults to 1").meta({ type: "integer" }).optional(),
			element_index: z.string().describe("Element index to click").optional(),
			mouse_button: z.enum(["left", "right", "middle"]).describe("Mouse button to click. Defaults to left.").optional(),
			x: z.number().describe("X coordinate in screenshot pixel coordinates").optional(),
			y: z.number().describe("Y coordinate in screenshot pixel coordinates").optional(),
		})
		.passthrough(),
	perform_secondary_action: z
		.object({
			app,
			element_index: z.string().describe("Element identifier"),
			action: z.string().describe("Secondary accessibility action name"),
		})
		.passthrough(),
	set_value: z
		.object({
			app,
			element_index: z.string().describe("Element identifier"),
			value: z.string().describe("Value to assign"),
		})
		.passthrough(),
	select_text: z
		.object({
			app: selectTextApp,
			element_index: z.string().describe("Text element identifier"),
			text: z.string().describe("Target text as shown in the accessibility tree"),
			prefix: z.string().describe("Optional text immediately before the target, used to disambiguate repeated matches").optional(),
			selection: z.enum(["text", "cursor_before", "cursor_after"]).describe("Whether to select the text or place the cursor before or after it. Defaults to text.").optional(),
			suffix: z.string().describe("Optional text immediately after the target, used to disambiguate repeated matches").optional(),
		})
		.passthrough(),
	scroll: z
		.object({
			app,
			element_index: z.string().describe("Element identifier"),
			direction: z.string().describe("Scroll direction: up, down, left, or right"),
			pages: z.number().describe("Number of pages to scroll. Fractional values are supported. Defaults to 1").optional(),
		})
		.passthrough(),
	drag: z
		.object({
			app,
			from_x: z.number().describe("Start X coordinate"),
			from_y: z.number().describe("Start Y coordinate"),
			to_x: z.number().describe("End X coordinate"),
			to_y: z.number().describe("End Y coordinate"),
		})
		.passthrough(),
	press_key: z.object({ app, key: z.string().describe("Key or key combination to press") }).passthrough(),
	type_text: z.object({ app, text: z.string().describe("Literal text to type") }).passthrough(),
} as const;

export type DirectMethod = keyof typeof DIRECT_TOOL_SCHEMAS;
export type DirectToolArguments = Record<string, unknown>;

export const COMPUTER_USE_METHODS = Object.freeze(Object.keys(DIRECT_TOOL_SCHEMAS) as DirectMethod[]);

export interface ToolMetadata {
	description: string;
	annotations: {
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
		readOnlyHint: boolean;
	};
}

const readAnnotations = Object.freeze({
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	readOnlyHint: true,
});
const actionAnnotations = Object.freeze({
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
	readOnlyHint: false,
});

export const TOOL_METADATA: Readonly<Record<DirectMethod, ToolMetadata>> = Object.freeze({
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
		description: "Press a key or key-combination on the keyboard, including modifier and navigation keys.\n  - This supports xdotool's `key` syntax.\n  - Examples: \"a\", \"Return\", \"Tab\", \"super+c\", \"Up\", \"KP_0\" (for the numpad 0 key).",
		annotations: actionAnnotations,
	},
	type_text: {
		description: "Type literal text using keyboard input",
		annotations: actionAnnotations,
	},
});

export const MUTATING_METHODS = new Set<DirectMethod>(
	COMPUTER_USE_METHODS.filter((method) => !TOOL_METADATA[method].annotations.readOnlyHint),
);

export function isDirectMethod(value: string): value is DirectMethod {
	return COMPUTER_USE_METHODS.includes(value as DirectMethod);
}

export function validateDirectArguments(method: DirectMethod, value: unknown): DirectToolArguments {
	return DIRECT_TOOL_SCHEMAS[method].parse(value) as DirectToolArguments;
}

export const TOOL_INPUT_SCHEMAS = Object.freeze(Object.fromEntries(
	COMPUTER_USE_METHODS.map((method) => {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(DIRECT_TOOL_SCHEMAS[method]);
		return [method, inputSchema];
	}),
)) as Readonly<Record<DirectMethod, unknown>>;
