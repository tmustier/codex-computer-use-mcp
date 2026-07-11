import { z } from "zod";

const app = z.string().trim().min(1).max(500).describe("App name, full app path, or unambiguous bundle identifier");
const elementIndex = z.string().trim().min(1).max(200).describe("Element identifier from computer_use_get_app_state");
const coordinate = z.number().finite().min(0).max(1_000_000);

export const DIRECT_TOOL_SCHEMAS = {
	list_apps: z.object({}).strict(),
	get_app_state: z.object({ app }).strict(),
	click: z
		.object({
			app,
			click_count: z.number().int().min(1).max(10).optional(),
			element_index: elementIndex.optional(),
			mouse_button: z.enum(["left", "right", "middle"]).optional(),
			x: coordinate.optional(),
			y: coordinate.optional(),
		})
		.strict(),
	perform_secondary_action: z
		.object({ app, element_index: elementIndex, action: z.string().trim().min(1).max(200) })
		.strict(),
	set_value: z.object({ app, element_index: elementIndex, value: z.string().max(20_000) }).strict(),
	select_text: z
		.object({
			app,
			element_index: elementIndex,
			text: z.string().min(1).max(20_000),
			prefix: z.string().max(2_000).optional(),
			selection: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
			suffix: z.string().max(2_000).optional(),
		})
		.strict(),
	scroll: z
		.object({
			app,
			element_index: elementIndex,
			direction: z.enum(["up", "down", "left", "right"]),
			pages: z.number().finite().positive().max(100).optional(),
		})
		.strict(),
	drag: z
		.object({ app, from_x: coordinate, from_y: coordinate, to_x: coordinate, to_y: coordinate })
		.strict(),
	press_key: z.object({ app, key: z.string().trim().min(1).max(100).describe("Official xdotool-style key name or combination, for example Meta_L+a, Return, or Escape") }).strict(),
	type_text: z.object({ app, text: z.string().max(20_000) }).strict(),
} as const;

export type DirectMethod = keyof typeof DIRECT_TOOL_SCHEMAS;
export type DirectToolArguments = Record<string, unknown>;

export const OFFICIAL_METHODS = Object.freeze(Object.keys(DIRECT_TOOL_SCHEMAS) as DirectMethod[]);
export const READ_ONLY_METHODS = new Set<DirectMethod>(["list_apps", "get_app_state"]);
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
