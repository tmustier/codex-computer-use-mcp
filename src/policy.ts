export const MODEL = "gpt-5.6-sol";
export const MODEL_REASONING = "xhigh";
export type ReasoningEffort = "low" | "high" | "xhigh";

export const COMPUTER_USE_TOOLS = [
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

export type ComputerUseTool = (typeof COMPUTER_USE_TOOLS)[number];
export type Mode = "list" | "inspect" | "act" | "dictionary_lookup";
export type PermissionMode = "safe" | "full-permissions";
export const DICTIONARY_BUNDLE_ID = "com.apple.Dictionary";
export const DICTIONARY_NEUTRAL_QUERY = "dictionary";

export interface NativeAppInput {
	mode: Mode;
	app?: string;
	task?: string;
	query?: string;
	cleanup?: boolean;
	cleanup_instructions?: string;
	required_capabilities?: ComputerUseTool[];
}

export interface ValidatedRequest {
	mode: Mode;
	permissionMode: PermissionMode;
	app?: string;
	task?: string;
	query?: string;
	cleanup: boolean;
	cleanupInstructions?: string;
	requiredCapabilities: ComputerUseTool[];
	mutating: boolean;
	maxComputerUseCalls: number;
	reasoningEffort: ReasoningEffort;
}

export class PolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyError";
	}
}

const BLOCKED_APP_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
	{
		pattern: /(?:^|\b)(?:terminal|iterm\w*|ghostty|cmux|warp|wezterm|alacritty|kitty|hyper|tabby)(?:\b|$)/i,
		category: "terminal/shell",
	},
	{ pattern: /(?:^|\b)(?:chatgpt|codex)(?:\b|$)/i, category: "agent host" },
	{ pattern: /(?:^|\b)(?:keychain|1password|bitwarden|dashlane|lastpass|password)(?:\b|$)/i, category: "credentials" },
	{ pattern: /(?:^|\b)(?:mail|messages|slack|whatsapp|teams|discord|telegram|signal)(?:\b|$)/i, category: "communications" },
	{
		pattern: /(?:^|\b)(?:safari|chrome|firefox|arc|browser|edge|opera|vivaldi|brave|orion)(?:\b|$)/i,
		category: "browser",
	},
	{
		pattern: /(?:^|\b)(?:vscode|vs code|visual studio code|cursor|windsurf|zed)(?:\b|$)/i,
		category: "editor/agent host",
	},
	{ pattern: /(?:^|\b)(?:system settings|system preferences|settings|wallet|app store)(?:\b|$)/i, category: "system/payment settings" },
];

const BLOCKED_BUNDLE_ID_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
	{
		pattern: /(?:^|\.)(?:terminal|iterm2?|ghostty|cmuxterm|warp(?:-stable)?|wezterm|alacritty|kitty|hyper|tabby)(?:\.|$)/i,
		category: "terminal/shell",
	},
	{ pattern: /(?:^|\.)(?:chatgpt|codex|chat)(?:\.|$)/i, category: "agent host" },
	{
		pattern: /(?:^|\.)(?:keychainaccess|1password|bitwarden|dashlane\w*|lastpass\w*|passwords?)(?:\.|$)/i,
		category: "credentials",
	},
	{
		pattern: /(?:^|\.)(?:mail|mobilesms|slack(?:macgap)?|whatsapp|teams2?|discord|telegram|signal(?:-desktop)?)(?:\.|$)/i,
		category: "communications",
	},
	{
		pattern: /(?:^|\.)(?:safari|chrome|firefox|browser|edgemac|opera|vivaldi|brave|orion|kagimacos)(?:\.|$)/i,
		category: "browser",
	},
	{ pattern: /(?:^|\.)(?:vscode\w*|cursor|windsurf|zed)(?:\.|$)/i, category: "editor/agent host" },
	{ pattern: /(?:^|\.)(?:systempreferences|wallet|appstore)(?:\.|$)/i, category: "system/payment settings" },
];

const BLOCKED_OPAQUE_BUNDLE_IDS = new Map<string, string>([
	["com.todesktop.230313mzl4w4u92", "editor/agent host"], // Cursor
]);

function blockedSafeAppCategory(value: string): string | undefined {
	for (const blocked of BLOCKED_APP_PATTERNS) {
		if (blocked.pattern.test(value)) return blocked.category;
	}
	if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)) {
		const exactCategory = BLOCKED_OPAQUE_BUNDLE_IDS.get(value.toLowerCase());
		if (exactCategory) return exactCategory;
		for (const blocked of BLOCKED_BUNDLE_ID_PATTERNS) {
			if (blocked.pattern.test(value)) return blocked.category;
		}
	}
	return undefined;
}

const BLOCKED_TASK_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
	{ pattern: /\b(?:send|post|publish|share|upload|message|email|call)\b/i, category: "external communication" },
	{ pattern: /\b(?:buy|purchase|checkout|pay|payment|subscribe)\b/i, category: "purchase/payment" },
	{ pattern: /\b(?:password|passcode|credential|secret|token|api key|login|log in|sign in|authenticate)\b/i, category: "credentials/authentication" },
	{ pattern: /\b(?:sudo|admin|administrator|privacy prompt|permission prompt|tcc)\b/i, category: "admin/privacy approval" },
	{ pattern: /\b(?:delete|erase|trash|uninstall|wipe)\b/i, category: "destructive deletion" },
];

function validateSafeApp(app: unknown): string {
	if (typeof app !== "string") throw new PolicyError("inspect/act requires an app name or bundle identifier");
	const trimmed = app.trim();
	if (!trimmed || trimmed.length > 120) throw new PolicyError("App must be 1-120 characters");
	if (/[\u0000-\u001f\u007f\n\r]/.test(trimmed) || trimmed.includes("/") || /:/.test(trimmed)) {
		throw new PolicyError("App must be a name or bundle identifier, not a path, URL, or control string");
	}
	const blockedCategory = blockedSafeAppCategory(trimmed);
	if (blockedCategory) throw new PolicyError(`App is blocked by the ${blockedCategory} safety policy`);
	return trimmed;
}

function validateFullApp(app: unknown): string {
	if (typeof app !== "string") throw new PolicyError("inspect/act requires an app target");
	const trimmed = app.trim();
	if (!trimmed || trimmed.length > 500) throw new PolicyError("Full-permissions app target must be 1-500 characters");
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new PolicyError("App target contains unsupported control characters");
	return trimmed;
}

function validateSafeTask(task: unknown): string {
	if (typeof task !== "string") throw new PolicyError("act requires a concrete task");
	const trimmed = task.trim();
	if (!trimmed || trimmed.length > 1000) throw new PolicyError("Task must be 1-1000 characters");
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
		throw new PolicyError("Task contains unsupported control characters");
	}
	for (const blocked of BLOCKED_TASK_PATTERNS) {
		if (blocked.pattern.test(trimmed)) throw new PolicyError(`Task is blocked as ${blocked.category}`);
	}
	return trimmed;
}

function isDictionarySelector(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "dictionary" || normalized === DICTIONARY_BUNDLE_ID.toLowerCase();
}

function validateFullTask(task: unknown): string {
	if (typeof task !== "string") throw new PolicyError("act requires a concrete task");
	const trimmed = task.trim();
	if (!trimmed || trimmed.length > 4000) throw new PolicyError("Full-permissions task must be 1-4000 characters");
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
		throw new PolicyError("Task contains unsupported control characters");
	}
	return trimmed;
}

function validateDictionaryQuery(value: unknown): string {
	if (typeof value !== "string") throw new PolicyError("dictionary_lookup requires a query");
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 200) throw new PolicyError("Dictionary query must be 1-200 characters");
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new PolicyError("Dictionary query contains unsupported control characters");
	return trimmed;
}

function validateCleanupInstructions(value: unknown, permissionMode: PermissionMode): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new PolicyError("cleanup_instructions must be text");
	const trimmed = value.trim();
	const maxLength = permissionMode === "full-permissions" ? 2000 : 500;
	if (!trimmed || trimmed.length > maxLength) throw new PolicyError(`cleanup_instructions must be 1-${maxLength} characters`);
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
		throw new PolicyError("Cleanup instructions contain unsupported control characters");
	}
	if (permissionMode === "safe") {
		for (const blocked of BLOCKED_TASK_PATTERNS) {
			if (blocked.pattern.test(trimmed)) throw new PolicyError(`Cleanup instructions are blocked as ${blocked.category}`);
		}
	}
	return trimmed;
}

function validateRequiredCapabilities(value: unknown): ComputerUseTool[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new PolicyError("required_capabilities must be an array");
	const available = new Set<string>(COMPUTER_USE_TOOLS);
	const result: ComputerUseTool[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !available.has(item)) throw new PolicyError(`Unknown Computer Use capability: ${String(item)}`);
		if (item === "list_apps" || item === "get_app_state") continue;
		if (!result.includes(item as ComputerUseTool)) result.push(item as ComputerUseTool);
	}
	return result;
}

export function validateRequest(input: NativeAppInput, permissionMode: PermissionMode = "safe"): ValidatedRequest {
	if (!input || typeof input !== "object") throw new PolicyError("Request must be an object");
	if (permissionMode !== "safe" && permissionMode !== "full-permissions") throw new PolicyError("Invalid permission mode");
	if (permissionMode === "safe" && input.mode !== "list") {
		throw new PolicyError(
			"Standalone safe mode permits only list: target and argument checks are observable only after the signed official client dispatches a call. Enable explicit full-permissions only if that broad authorization is acceptable.",
		);
	}

	switch (input.mode) {
		case "list":
			if (
				input.app !== undefined ||
				input.task !== undefined ||
				input.query !== undefined ||
				input.cleanup !== undefined ||
				input.cleanup_instructions !== undefined ||
				input.required_capabilities !== undefined
			) {
				throw new PolicyError("list accepts only mode");
			}
			return {
				mode: "list",
				permissionMode,
				cleanup: true,
				requiredCapabilities: [],
				mutating: false,
				maxComputerUseCalls: 1,
				reasoningEffort: "low",
			};

		case "inspect":
			if (
				input.task !== undefined ||
				input.query !== undefined ||
				input.cleanup !== undefined ||
				input.cleanup_instructions !== undefined ||
				input.required_capabilities !== undefined
			) {
				throw new PolicyError("inspect accepts only app");
			}
			return {
				mode: "inspect",
				permissionMode,
				app: permissionMode === "full-permissions" ? validateFullApp(input.app) : validateSafeApp(input.app),
				cleanup: true,
				requiredCapabilities: [],
				mutating: false,
				maxComputerUseCalls: 3,
				reasoningEffort: "high",
			};

		case "act": {
			const app = permissionMode === "full-permissions" ? validateFullApp(input.app) : validateSafeApp(input.app);
			if (permissionMode === "safe" && isDictionarySelector(app)) {
				throw new PolicyError("Dictionary is restricted to inspect or dictionary_lookup in safe mode");
			}
			if (input.query !== undefined) throw new PolicyError("act does not accept query; use task");
			const cleanup = input.cleanup ?? (permissionMode === "safe");
			if (!cleanup && input.cleanup_instructions !== undefined) {
				throw new PolicyError("act does not accept cleanup_instructions when cleanup is false");
			}
			return {
				mode: "act",
				permissionMode,
				app,
				task: permissionMode === "full-permissions" ? validateFullTask(input.task) : validateSafeTask(input.task),
				cleanup,
				cleanupInstructions: cleanup ? validateCleanupInstructions(input.cleanup_instructions, permissionMode) : undefined,
				requiredCapabilities: validateRequiredCapabilities(input.required_capabilities),
				mutating: true,
				maxComputerUseCalls: 50,
				reasoningEffort: "xhigh",
			};
		}

		case "dictionary_lookup":
			if (
				input.app !== undefined ||
				input.task !== undefined ||
				input.cleanup !== undefined ||
				input.cleanup_instructions !== undefined ||
				input.required_capabilities !== undefined
			) {
				throw new PolicyError("dictionary_lookup accepts only query");
			}
			return {
				mode: "dictionary_lookup",
				permissionMode,
				app: DICTIONARY_BUNDLE_ID,
				query: validateDictionaryQuery(input.query),
				cleanup: true,
				requiredCapabilities: ["set_value"],
				mutating: true,
				maxComputerUseCalls: 8,
				reasoningEffort: "high",
			};

		default:
			throw new PolicyError(`Unsupported mode: ${String((input as NativeAppInput).mode)}`);
	}
}

export function allowedToolsForRequest(request: ValidatedRequest): ComputerUseTool[] {
	switch (request.mode) {
		case "list":
			return ["list_apps"];
		case "inspect":
			return ["list_apps", "get_app_state"];
		case "act":
			return [...COMPUTER_USE_TOOLS];
		case "dictionary_lookup":
			return ["get_app_state", "set_value", "scroll"];
	}
}

export function isDictionaryAlwaysAllowed(
	request: ValidatedRequest,
	resolvedBundleId: string | undefined,
	verifiedSystemDictionary: boolean,
): boolean {
	return (
		request.permissionMode === "safe" &&
		verifiedSystemDictionary &&
		resolvedBundleId === DICTIONARY_BUNDLE_ID &&
		(request.mode === "inspect" || request.mode === "dictionary_lookup")
	);
}

export function requiresPiConfirmation(
	request: ValidatedRequest,
	resolvedBundleId: string | undefined,
	verifiedSystemDictionary: boolean,
): boolean {
	if (request.permissionMode === "full-permissions") return false;
	return request.mode !== "list" && !isDictionaryAlwaysAllowed(request, resolvedBundleId, verifiedSystemDictionary);
}

export function validateResolvedAppIdentity(
	request: ValidatedRequest,
	resolvedBundleId: string | undefined,
	verifiedSystemDictionary: boolean,
): void {
	if (request.permissionMode === "safe" && resolvedBundleId) {
		const blockedCategory = blockedSafeAppCategory(resolvedBundleId);
		if (blockedCategory) {
			throw new PolicyError(`Resolved app is blocked by the ${blockedCategory} safety policy`);
		}
	}
	if (request.mode === "dictionary_lookup" && !verifiedSystemDictionary) {
		throw new PolicyError("Dictionary lookup requires the running Apple-signed system Dictionary at its fixed system path");
	}
	if (request.permissionMode === "safe" && request.mode === "act" && verifiedSystemDictionary) {
		throw new PolicyError("Generic actions against Dictionary are blocked after canonical identity resolution in safe mode");
	}
}

export type ComputerUseArgumentValidator = (tool: string, args: Record<string, unknown>) => string | undefined;

export function createDictionaryArgumentValidator(query: string): ComputerUseArgumentValidator {
	let setCount = 0;
	let searchElement: string | undefined;
	return (tool, args) => {
		if (tool === "set_value") {
			if (typeof args.element_index !== "string" || typeof args.value !== "string") {
				return "Dictionary set_value arguments were not typed strings";
			}
			setCount += 1;
			if (setCount === 1) {
				if (args.value !== query) return "Dictionary lookup attempted to set a value other than the approved query";
				searchElement = args.element_index;
				return undefined;
			}
			if (setCount === 2) {
				if (args.element_index !== searchElement) return "Dictionary cleanup targeted a different element than the lookup";
				if (args.value !== DICTIONARY_NEUTRAL_QUERY) return "Dictionary cleanup did not restore the fixed neutral query";
				return undefined;
			}
			return "Dictionary lookup attempted more than two value assignments";
		}
		if (tool === "scroll") {
			if (!["up", "down"].includes(String(args.direction))) return "Dictionary lookup attempted a non-vertical scroll";
			if (args.pages !== undefined && (typeof args.pages !== "number" || args.pages <= 0 || args.pages > 3)) {
				return "Dictionary lookup attempted an out-of-bounds scroll";
			}
		}
		return undefined;
	};
}

const MUTATION_METHODS = new Set<ComputerUseTool>([
	"click",
	"perform_secondary_action",
	"set_value",
	"select_text",
	"scroll",
	"drag",
	"press_key",
	"type_text",
]);

export function validateObservedMethods(request: ValidatedRequest, methods: string[]): void {
	if (methods.length === 0) throw new PolicyError("Codex completed without an observed Computer Use method call");
	if (methods.length > request.maxComputerUseCalls) {
		throw new PolicyError(`Computer Use call budget exceeded (${methods.length}/${request.maxComputerUseCalls})`);
	}
	const available = new Set<string>(allowedToolsForRequest(request));
	for (const method of methods) {
		if (!available.has(method)) throw new PolicyError(`Computer Use method is outside policy: ${method}`);
	}
	if (request.mode === "list") {
		if (methods.length !== 1 || methods[0] !== "list_apps") throw new PolicyError("list must make exactly one list_apps call");
		return;
	}
	if (!methods.includes("get_app_state")) throw new PolicyError(`${request.mode} must inspect app state`);
	if (request.mode === "inspect") {
		if (methods.some((method) => MUTATION_METHODS.has(method as ComputerUseTool))) {
			throw new PolicyError("inspect attempted a mutating Computer Use method");
		}
		return;
	}
	if (request.mode === "dictionary_lookup") {
		const stateIndexes = methods
			.map((method, index) => (method === "get_app_state" ? index : -1))
			.filter((index) => index >= 0);
		const setIndexes = methods
			.map((method, index) => (method === "set_value" ? index : -1))
			.filter((index) => index >= 0);
		if (setIndexes.length !== 2) throw new PolicyError("dictionary_lookup must set the query once and restore the fixed neutral query once");
		if (stateIndexes[0] > setIndexes[0]) throw new PolicyError("dictionary_lookup did not inspect Dictionary before setting the query");
		if (!stateIndexes.some((index) => index > setIndexes[0] && index < setIndexes[1])) {
			throw new PolicyError("dictionary_lookup did not inspect the lookup result before cleanup");
		}
		if (!stateIndexes.some((index) => index > setIndexes[1])) {
			throw new PolicyError("dictionary_lookup did not verify restoration of the fixed neutral query");
		}
		return;
	}

	const mutationIndexes = methods
		.map((method, index) => (MUTATION_METHODS.has(method as ComputerUseTool) ? index : -1))
		.filter((index) => index >= 0);
	const stateIndexes = methods
		.map((method, index) => (method === "get_app_state" ? index : -1))
		.filter((index) => index >= 0);
	if (mutationIndexes.length === 0) throw new PolicyError("act completed without a mutating Computer Use method");
	if (stateIndexes[0] > mutationIndexes[0]) throw new PolicyError("act did not inspect the target before mutation");
	if (!stateIndexes.some((index) => index > mutationIndexes.at(-1)!)) {
		throw new PolicyError("act did not verify target state after the final mutation");
	}
	for (const capability of request.requiredCapabilities) {
		if (!methods.includes(capability)) throw new PolicyError(`Required Computer Use capability was not exercised: ${capability}`);
	}
	if (request.cleanup && stateIndexes.filter((index) => index > mutationIndexes[0]).length < 2) {
		throw new PolicyError("act did not separately verify task result and cleanup state");
	}
}
