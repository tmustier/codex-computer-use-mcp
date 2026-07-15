import { z } from "zod";

const app = z.string().describe("App name, full app path, or unambiguous bundle identifier");
const selectTextApp = z.string().describe("App name or bundle identifier");

export const DIRECT_TOOL_SCHEMAS = {
	list_apps: z.object({}).strict(),
	get_app_state: z.object({ app }).strict(),
	click: z
		.object({
			app,
			click_count: z.number().refine(Number.isInteger).describe("Number of clicks. Defaults to 1").optional(),
			element_index: z.string().describe("Element index to click").optional(),
			mouse_button: z.enum(["left", "right", "middle"]).describe("Mouse button to click. Defaults to left.").optional(),
			x: z.number().describe("X coordinate in screenshot pixel coordinates").optional(),
			y: z.number().describe("Y coordinate in screenshot pixel coordinates").optional(),
		})
		.strict(),
	perform_secondary_action: z
		.object({
			app,
			element_index: z.string().describe("Element identifier"),
			action: z.string().describe("Secondary accessibility action name"),
		})
		.strict(),
	set_value: z
		.object({
			app,
			element_index: z.string().describe("Element identifier"),
			value: z.string().describe("Value to assign"),
		})
		.strict(),
	select_text: z
		.object({
			app: selectTextApp,
			element_index: z.string().describe("Text element identifier"),
			text: z.string().describe("Target text as shown in the accessibility tree"),
			prefix: z.string().describe("Optional text immediately before the target, used to disambiguate repeated matches").optional(),
			selection: z.enum(["text", "cursor_before", "cursor_after"]).describe("Whether to select the text or place the cursor before or after it. Defaults to text.").optional(),
			suffix: z.string().describe("Optional text immediately after the target, used to disambiguate repeated matches").optional(),
		})
		.strict(),
	scroll: z
		.object({
			app,
			element_index: z.string().describe("Element identifier"),
			direction: z.string().describe("Scroll direction: up, down, left, or right"),
			pages: z.number().describe("Number of pages to scroll. Fractional values are supported. Defaults to 1").optional(),
		})
		.strict(),
	drag: z
		.object({
			app,
			from_x: z.number().describe("Start X coordinate"),
			from_y: z.number().describe("Start Y coordinate"),
			to_x: z.number().describe("End X coordinate"),
			to_y: z.number().describe("End Y coordinate"),
		})
		.strict(),
	press_key: z.object({ app, key: z.string().describe("Key or key combination to press") }).strict(),
	type_text: z.object({ app, text: z.string().describe("Literal text to type") }).strict(),
} as const;

export type DirectMethod = keyof typeof DIRECT_TOOL_SCHEMAS;
export type DirectToolArguments = Record<string, unknown>;

export const OFFICIAL_METHODS = Object.freeze(Object.keys(DIRECT_TOOL_SCHEMAS) as DirectMethod[]);

export interface OfficialToolMetadata {
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

/** Exact upstream descriptions and annotations exposed by the signed Computer Use helper. */
export const OFFICIAL_TOOL_METADATA: Readonly<Record<DirectMethod, OfficialToolMetadata>> = Object.freeze({
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

export const READ_ONLY_METHODS = new Set<DirectMethod>(OFFICIAL_METHODS.filter((method) => OFFICIAL_TOOL_METADATA[method].annotations.readOnlyHint));
export const MUTATING_METHODS = new Set<DirectMethod>(OFFICIAL_METHODS.filter((method) => !READ_ONLY_METHODS.has(method)));

export function isDirectMethod(value: string): value is DirectMethod {
	return OFFICIAL_METHODS.includes(value as DirectMethod);
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
	cmd: "Meta_L",
	command: "Meta_L",
	meta: "Meta_L",
	ctrl: "Control_L",
	control: "Control_L",
	shift: "Shift_L",
	alt: "Alt_L",
	option: "Alt_L",
	enter: "Return",
	return: "Return",
	esc: "Escape",
	escape: "Escape",
	backspace: "BackSpace",
	delete: "Delete",
	pageup: "Page_Up",
	pagedown: "Page_Down",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
};

export function normalizeKeyExpression(value: string): string {
	return value
		.split("+")
		.map((part) => {
			const trimmed = part.trim();
			const alias = KEY_ALIASES[trimmed.toLowerCase()];
			if (alias) return alias;
			return /^[A-Z]$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
		})
		.join("+");
}

export function validateDirectArguments(method: DirectMethod, value: unknown): DirectToolArguments {
	const parsed = DIRECT_TOOL_SCHEMAS[method].parse(value) as DirectToolArguments;
	if (method === "press_key") return { ...parsed, key: normalizeKeyExpression(parsed.key as string) };
	return parsed;
}

export function targetAppFor(method: DirectMethod, args: DirectToolArguments): string | undefined {
	return method === "list_apps" ? undefined : (args.app as string | undefined);
}

/** Exact upstream MCP schemas observed from the signed helper. Drift fails closed before dispatch. */
export const EXPECTED_OFFICIAL_INPUT_SCHEMAS: Readonly<Record<DirectMethod, unknown>> = {
	list_apps: { type: "object", properties: {}, additionalProperties: false },
	get_app_state: {
		type: "object",
		properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" } },
		required: ["app"],
		additionalProperties: false,
	},
	click: {
		type: "object",
		properties: {
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			click_count: { description: "Number of clicks. Defaults to 1", type: "integer" },
			element_index: { description: "Element index to click", type: "string" },
			mouse_button: { description: "Mouse button to click. Defaults to left.", enum: ["left", "right", "middle"], type: "string" },
			x: { description: "X coordinate in screenshot pixel coordinates", type: "number" },
			y: { description: "Y coordinate in screenshot pixel coordinates", type: "number" },
		},
		required: ["app"],
		additionalProperties: false,
	},
	perform_secondary_action: {
		type: "object",
		properties: {
			action: { description: "Secondary accessibility action name", type: "string" },
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			element_index: { description: "Element identifier", type: "string" },
		},
		required: ["app", "element_index", "action"],
		additionalProperties: false,
	},
	set_value: {
		type: "object",
		properties: {
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			element_index: { description: "Element identifier", type: "string" },
			value: { description: "Value to assign", type: "string" },
		},
		required: ["app", "element_index", "value"],
		additionalProperties: false,
	},
	select_text: {
		type: "object",
		properties: {
			app: { description: "App name or bundle identifier", type: "string" },
			element_index: { description: "Text element identifier", type: "string" },
			prefix: { description: "Optional text immediately before the target, used to disambiguate repeated matches", type: "string" },
			selection: { description: "Whether to select the text or place the cursor before or after it. Defaults to text.", enum: ["text", "cursor_before", "cursor_after"], type: "string" },
			suffix: { description: "Optional text immediately after the target, used to disambiguate repeated matches", type: "string" },
			text: { description: "Target text as shown in the accessibility tree", type: "string" },
		},
		required: ["app", "element_index", "text"],
		additionalProperties: false,
	},
	scroll: {
		type: "object",
		properties: {
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			direction: { description: "Scroll direction: up, down, left, or right", type: "string" },
			element_index: { description: "Element identifier", type: "string" },
			pages: { description: "Number of pages to scroll. Fractional values are supported. Defaults to 1", type: "number" },
		},
		required: ["app", "element_index", "direction"],
		additionalProperties: false,
	},
	drag: {
		type: "object",
		properties: {
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			from_x: { description: "Start X coordinate", type: "number" },
			from_y: { description: "Start Y coordinate", type: "number" },
			to_x: { description: "End X coordinate", type: "number" },
			to_y: { description: "End Y coordinate", type: "number" },
		},
		required: ["app", "from_x", "from_y", "to_x", "to_y"],
		additionalProperties: false,
	},
	press_key: {
		type: "object",
		properties: {
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			key: { description: "Key or key combination to press", type: "string" },
		},
		required: ["app", "key"],
		additionalProperties: false,
	},
	type_text: {
		type: "object",
		properties: {
			app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" },
			text: { description: "Literal text to type", type: "string" },
		},
		required: ["app", "text"],
		additionalProperties: false,
	},
};
