import { z } from "zod";
import type { DirectToolArguments, JsonObject, ToolInputSchema, ToolMetadata } from "./tools.ts";

// The official Windows Computer Use surface is the `@oai/sky` window2 API that
// Codex drives from its node_repl runtime. Argument names, shapes and
// descriptions follow the bundled `docs/api.md` of that package.

const additionalArgument = z.json();
const app = z.string().describe("App identifier: canonical app id from list_apps, process name, or .exe path");
const windowObject = z.object({
	app: z.string().describe("App identifier that owns the window, as returned by list_apps or list_windows"),
	id: z.number().int().describe("Opaque window identifier from list_apps or list_windows"),
	title: z.string().describe("Window title, when available").optional(),
}).catchall(additionalArgument).describe("Window object from list_apps or list_windows, passed unchanged");
const elementIndex = z.union([z.number().int().nonnegative(), z.string()])
	.describe("Element index from the latest get_window_state accessibility tree");
const screenshotId = z.string().describe("Screenshot id from the latest get_window_state of the target window");

export const WINDOWS_COMPUTER_USE_METHODS = [
	"list_apps",
	"list_windows",
	"get_window",
	"launch_app",
	"get_window_state",
	"click",
	"press_key",
	"type_text",
	"scroll",
	"set_value",
	"drag",
	"perform_secondary_action",
	"activate_window",
] as const;

export type WindowsDirectMethod = typeof WINDOWS_COMPUTER_USE_METHODS[number];

const WINDOWS_TOOL_SCHEMAS = {
	list_apps: z.object({}).catchall(additionalArgument),
	list_windows: z.object({}).catchall(additionalArgument),
	get_window: z.object({
		id: z.number().int().describe("Opaque window identifier from a previously returned window"),
		app: app.describe("Optional app identifier carried forward from a previously returned window").optional(),
	}).catchall(additionalArgument),
	launch_app: z.object({
		app: app.describe("App id from list_apps, or an explicit .exe process path for an app that is not listed yet"),
	}).catchall(additionalArgument),
	get_window_state: z.object({
		window: windowObject,
		include_screenshot: z.boolean().describe("Capture a screenshot of the window. Defaults to true").optional(),
		include_text: z.boolean().describe("Capture accessibility text with element indexes. Defaults to false").optional(),
	}).catchall(additionalArgument),
	click: z.object({
		window: windowObject,
		click_count: z.number().int().describe("Number of clicks. Defaults to 1").optional(),
		element_index: elementIndex.optional(),
		mouse_button: z.enum(["left", "right", "middle"]).describe("Mouse button to click. Defaults to left.").optional(),
		screenshotId: screenshotId.optional(),
		x: z.number().describe("Window-relative X coordinate").optional(),
		y: z.number().describe("Window-relative Y coordinate").optional(),
	}).catchall(additionalArgument),
	press_key: z.object({
		window: windowObject,
		key: z.string().describe("Key or `+`-separated chord using keysym names, such as `a`, `Return`, `Tab`, `Control_L+a`, or `KP_0`"),
	}).catchall(additionalArgument),
	type_text: z.object({
		window: windowObject,
		text: z.string().describe("Literal text to type into the current focus"),
	}).catchall(additionalArgument),
	scroll: z.object({
		window: windowObject,
		x: z.number().describe("Window-relative X coordinate to scroll from"),
		y: z.number().describe("Window-relative Y coordinate to scroll from"),
		scrollX: z.number().describe("Horizontal scroll delta; negative scrolls left"),
		scrollY: z.number().describe("Vertical scroll delta; negative scrolls up"),
		screenshotId: screenshotId.optional(),
	}).catchall(additionalArgument),
	set_value: z.object({
		window: windowObject,
		element_index: elementIndex,
		value: z.string().describe("Replacement value for the editable element"),
	}).catchall(additionalArgument),
	drag: z.object({
		window: windowObject,
		from_x: z.number().describe("Starting window-relative X coordinate"),
		from_y: z.number().describe("Starting window-relative Y coordinate"),
		to_x: z.number().describe("Ending window-relative X coordinate"),
		to_y: z.number().describe("Ending window-relative Y coordinate"),
		screenshotId: screenshotId.optional(),
	}).catchall(additionalArgument),
	perform_secondary_action: z.object({
		window: windowObject,
		element_index: elementIndex,
		action: z.string().describe("Secondary action label from get_window_state, such as Raise, Scroll Up, Expand, or Collapse"),
	}).catchall(additionalArgument),
	activate_window: z.object({ window: windowObject }).catchall(additionalArgument),
} satisfies Record<WindowsDirectMethod, z.ZodType>;

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

export const WINDOWS_TOOL_METADATA = {
	list_apps: {
		description: "List installed apps, including their currently open targetable windows when present. Pass a returned window object unchanged as the window argument of later calls",
		annotations: readAnnotations,
	},
	list_windows: {
		description: "List open windows that can be targeted",
		annotations: readAnnotations,
	},
	get_window: {
		description: "Rehydrate a currently open window by id; useful after losing a window binding",
		annotations: readAnnotations,
	},
	launch_app: {
		description: "Launch an app by id so its window can be selected from list_apps",
		annotations: actionAnnotations,
	},
	get_window_state: {
		description: "Capture the state of an open window: a screenshot by default, and the indexed accessibility text when include_text is true. Call this before interacting with a window and again after acting",
		annotations: readAnnotations,
	},
	click: {
		description: "Click either an indexed element from the latest window state or a window-relative coordinate",
		annotations: actionAnnotations,
	},
	press_key: {
		description: "Press a key or `+`-separated keyboard chord in a window using keysym names, such as `Return`, `Tab`, `Control_L+a`, or `KP_0`",
		annotations: actionAnnotations,
	},
	type_text: {
		description: "Type literal text into the current focus in a window",
		annotations: actionAnnotations,
	},
	scroll: {
		description: "Scroll by scrollX and scrollY deltas from a window-relative coordinate",
		annotations: actionAnnotations,
	},
	set_value: {
		description: "Replace the value of an indexed editable element",
		annotations: actionAnnotations,
	},
	drag: {
		description: "Drag from one window-relative coordinate to another",
		annotations: actionAnnotations,
	},
	perform_secondary_action: {
		description: "Invoke a secondary accessibility action on an indexed element, such as Raise, Scroll Up, Expand, or Collapse",
		annotations: actionAnnotations,
	},
	activate_window: {
		description: "Bring an open window to the foreground; input methods activate their target window automatically",
		annotations: actionAnnotations,
	},
} satisfies Record<WindowsDirectMethod, ToolMetadata>;

const methodNames = new Set<string>(WINDOWS_COMPUTER_USE_METHODS);

export function isWindowsDirectMethod(value: string): value is WindowsDirectMethod {
	return methodNames.has(value);
}

export function validateWindowsArguments(method: WindowsDirectMethod, value: JsonObject): DirectToolArguments {
	return WINDOWS_TOOL_SCHEMAS[method].parse(value);
}

function inputSchema(schema: z.ZodType): ToolInputSchema {
	const { $schema: _schema, ...result } = z.toJSONSchema(schema);
	return result;
}

export const WINDOWS_TOOL_INPUT_SCHEMAS = {
	list_apps: inputSchema(WINDOWS_TOOL_SCHEMAS.list_apps),
	list_windows: inputSchema(WINDOWS_TOOL_SCHEMAS.list_windows),
	get_window: inputSchema(WINDOWS_TOOL_SCHEMAS.get_window),
	launch_app: inputSchema(WINDOWS_TOOL_SCHEMAS.launch_app),
	get_window_state: inputSchema(WINDOWS_TOOL_SCHEMAS.get_window_state),
	click: inputSchema(WINDOWS_TOOL_SCHEMAS.click),
	press_key: inputSchema(WINDOWS_TOOL_SCHEMAS.press_key),
	type_text: inputSchema(WINDOWS_TOOL_SCHEMAS.type_text),
	scroll: inputSchema(WINDOWS_TOOL_SCHEMAS.scroll),
	set_value: inputSchema(WINDOWS_TOOL_SCHEMAS.set_value),
	drag: inputSchema(WINDOWS_TOOL_SCHEMAS.drag),
	perform_secondary_action: inputSchema(WINDOWS_TOOL_SCHEMAS.perform_secondary_action),
	activate_window: inputSchema(WINDOWS_TOOL_SCHEMAS.activate_window),
} satisfies Record<WindowsDirectMethod, ToolInputSchema>;
