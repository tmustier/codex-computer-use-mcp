import assert from "node:assert/strict";
import test from "node:test";
import {
	COMPUTER_USE_TOOLS,
	DICTIONARY_BUNDLE_ID,
	DICTIONARY_NEUTRAL_QUERY,
	PolicyError,
	allowedToolsForRequest,
	createDictionaryArgumentValidator,
	isDictionaryAlwaysAllowed,
	requiresPiConfirmation,
	validateObservedMethods,
	validateRequest,
	validateResolvedAppIdentity,
} from "../src/policy.ts";

test("list is read-only and exposes only list_apps", () => {
	const request = validateRequest({ mode: "list" });
	assert.equal(request.mutating, false);
	assert.deepEqual(allowedToolsForRequest(request), ["list_apps"]);
	validateObservedMethods(request, ["list_apps"]);
	assert.throws(() => validateRequest({ mode: "list", app: "Calculator" }), PolicyError);
	assert.throws(() => validateRequest({ mode: "list", cleanup: true }), PolicyError);
	assert.throws(() => validateRequest({ mode: "list", required_capabilities: ["click"] }), PolicyError);
});

test("inspect targets a non-sensitive app and cannot mutate", () => {
	const request = validateRequest({ mode: "inspect", app: "com.example.Harness" });
	assert.equal(request.app, "com.example.Harness");
	validateObservedMethods(request, ["list_apps", "get_app_state"]);
	assert.throws(() => validateObservedMethods(request, ["get_app_state", "click"]), PolicyError);
	assert.throws(() => validateRequest({ mode: "inspect", app: "com.example.Harness", cleanup: true }), PolicyError);
	assert.throws(
		() => validateRequest({ mode: "inspect", app: "com.example.Harness", required_capabilities: ["click"] }),
		PolicyError,
	);
});

test("full action surface is available for confirmed act tasks", () => {
	const request = validateRequest({
		mode: "act",
		app: "Native Harness",
		task: "Exercise every benign control and restore the Reset state",
		required_capabilities: [
			"click",
			"perform_secondary_action",
			"set_value",
			"select_text",
			"scroll",
			"drag",
			"press_key",
			"type_text",
		],
	});
	assert.deepEqual(allowedToolsForRequest(request), [...COMPUTER_USE_TOOLS]);
	const methods = [
		"get_app_state",
		"click",
		"perform_secondary_action",
		"set_value",
		"select_text",
		"scroll",
		"drag",
		"press_key",
		"type_text",
		"get_app_state",
		"click",
		"get_app_state",
	];
	validateObservedMethods(request, methods);
});

test("Dictionary is always allowed only for identity-checked inspect and narrow lookup", () => {
	const inspect = validateRequest({ mode: "inspect", app: "Dictionary" });
	const lookup = validateRequest({ mode: "dictionary_lookup", query: "dragon" });
	assert.equal(isDictionaryAlwaysAllowed(inspect, DICTIONARY_BUNDLE_ID, true), true);
	assert.equal(isDictionaryAlwaysAllowed(lookup, DICTIONARY_BUNDLE_ID, true), true);
	assert.equal(requiresPiConfirmation(inspect, DICTIONARY_BUNDLE_ID, true), false);
	assert.equal(requiresPiConfirmation(lookup, DICTIONARY_BUNDLE_ID, true), false);
	assert.equal(isDictionaryAlwaysAllowed(inspect, DICTIONARY_BUNDLE_ID, false), false);
	assert.equal(isDictionaryAlwaysAllowed(inspect, "com.example.Dictionary", true), false);
	assert.equal(requiresPiConfirmation(inspect, "com.example.Dictionary", false), true);
	assert.equal(
		requiresPiConfirmation(validateRequest({ mode: "inspect", app: "Calculator" }), "com.apple.calculator", false),
		true,
	);
	assert.equal(
		requiresPiConfirmation(
			validateRequest({ mode: "act", app: "TextEdit", task: "Type transient text and restore" }),
			"com.apple.TextEdit",
			false,
		),
		true,
	);
	assert.equal(
		requiresPiConfirmation(
			validateRequest({ mode: "act", app: "TextEdit", task: "Type without asking" }, "full-permissions"),
			"com.apple.TextEdit",
			false,
		),
		false,
	);
	assert.deepEqual(allowedToolsForRequest(lookup), ["get_app_state", "set_value", "scroll"]);
	validateObservedMethods(lookup, ["get_app_state", "set_value", "get_app_state", "scroll", "set_value", "get_app_state"]);
	assert.throws(
		() => validateObservedMethods(lookup, ["get_app_state", "set_value", "get_app_state", "click", "set_value", "get_app_state"]),
		PolicyError,
	);
	assert.throws(
		() => validateObservedMethods(lookup, ["get_app_state", "set_value", "get_app_state"]),
		PolicyError,
	);
	assert.throws(() => validateRequest({ mode: "act", app: "Dictionary", task: "Click a result" }), PolicyError);
	assert.throws(() => validateRequest({ mode: "dictionary_lookup", query: "dragon", app: "Dictionary" }), PolicyError);
	assert.throws(
		() =>
			validateResolvedAppIdentity(
				validateRequest({ mode: "act", app: "Oxford Lexicon", task: "Change a control" }),
				DICTIONARY_BUNDLE_ID,
				true,
			),
		PolicyError,
	);
	assert.throws(() => validateResolvedAppIdentity(lookup, DICTIONARY_BUNDLE_ID, false), PolicyError);
	assert.doesNotThrow(() => validateResolvedAppIdentity(lookup, DICTIONARY_BUNDLE_ID, true));
	assert.doesNotThrow(() =>
		validateResolvedAppIdentity(
			validateRequest({ mode: "act", app: "Dictionary", task: "Use any official action" }, "full-permissions"),
			DICTIONARY_BUNDLE_ID,
			true,
		),
	);

	const validArgs = createDictionaryArgumentValidator("dragon");
	assert.equal(validArgs("set_value", { app: DICTIONARY_BUNDLE_ID, element_index: "search", value: "dragon" }), undefined);
	assert.equal(validArgs("scroll", { app: DICTIONARY_BUNDLE_ID, element_index: "definition", direction: "down", pages: 2 }), undefined);
	assert.equal(
		validArgs("set_value", {
			app: DICTIONARY_BUNDLE_ID,
			element_index: "search",
			value: DICTIONARY_NEUTRAL_QUERY,
		}),
		undefined,
	);
	const wrongQuery = createDictionaryArgumentValidator("dragon");
	assert.match(wrongQuery("set_value", { element_index: "search", value: "secret" })!, /approved query/);
	const wrongCleanup = createDictionaryArgumentValidator("dragon");
	wrongCleanup("set_value", { element_index: "search", value: "dragon" });
	assert.match(
		wrongCleanup("set_value", { element_index: "other", value: DICTIONARY_NEUTRAL_QUERY })!,
		/different element/,
	);
	const badScroll = createDictionaryArgumentValidator("dragon");
	assert.match(badScroll("scroll", { element_index: "definition", direction: "left", pages: 1 })!, /non-vertical/);
});

test("act requires pre-state, mutation, post-state, and separate cleanup verification", () => {
	const request = validateRequest({ mode: "act", app: "Calculator", task: "Enter 2+2, verify 4, then clear" });
	assert.throws(() => validateObservedMethods(request, ["click", "get_app_state", "click", "get_app_state"]), PolicyError);
	assert.throws(() => validateObservedMethods(request, ["get_app_state", "click", "get_app_state"]), PolicyError);
	validateObservedMethods(request, ["get_app_state", "click", "get_app_state", "click", "get_app_state"]);
});

test("high-risk apps and canonical bundle aliases fail closed without narrowing benign action methods", () => {
	for (const app of [
		"Terminal",
		"iTerm2",
		"com.googlecode.iterm2",
		"WezTerm",
		"Alacritty",
		"kitty",
		"Hyper",
		"Tabby",
		"ChatGPT",
		"Keychain Access",
		"Slack",
		"Safari",
		"Microsoft Edge",
		"Opera",
		"Vivaldi",
		"Brave",
		"Orion",
		"VS Code",
		"Cursor",
		"Windsurf",
		"Zed",
		"System Settings",
		"com.apple.Terminal",
		"com.mitchellh.ghostty",
		"com.cmuxterm.app",
		"com.openai.codex",
		"com.apple.keychainaccess",
		"com.1password.1password",
		"com.apple.Passwords",
		"com.apple.MobileSMS",
		"com.tinyspeck.slackmacgap",
		"net.whatsapp.WhatsApp",
		"com.microsoft.teams2",
		"com.apple.Safari",
		"com.google.Chrome",
		"org.mozilla.firefox",
		"com.microsoft.VSCode",
		"com.apple.systempreferences",
		"com.apple.AppStore",
	]) {
		assert.throws(() => validateRequest({ mode: "inspect", app }), PolicyError);
	}
	const benignAlias = validateRequest({ mode: "inspect", app: "Friendly Alias" });
	for (const resolvedBundleId of [
		"com.apple.MobileSMS",
		"com.tinyspeck.slackmacgap",
		"com.apple.Passwords",
		"com.apple.systempreferences",
	]) {
		assert.throws(() => validateResolvedAppIdentity(benignAlias, resolvedBundleId, false), PolicyError);
	}
	for (const task of ["send a message", "buy the item", "enter the password", "approve the privacy prompt", "delete the file"]) {
		assert.throws(() => validateRequest({ mode: "act", app: "Harness", task }), PolicyError);
	}
	assert.doesNotThrow(() =>
		validateRequest({
			mode: "act",
			app: "Harness",
			task: "Click the button, drag the slider, type test text, select it, scroll, press Escape, then reset",
		}),
	);
});

test("full-permissions removes wrapper app, intent, confirmation, and cleanup-default gates", () => {
	for (const [app, task] of [
		["Terminal", "run the requested command"],
		["Slack", "send the requested message"],
		["Safari", "purchase the requested item"],
		["Keychain Access", "inspect the requested credential"],
		["/Applications/Any App.app", "delete the requested content"],
	]) {
		const request = validateRequest({ mode: "act", app, task }, "full-permissions");
		assert.equal(request.permissionMode, "full-permissions");
		assert.equal(request.cleanup, false);
		assert.deepEqual(allowedToolsForRequest(request), [...COMPUTER_USE_TOOLS]);
		assert.equal(requiresPiConfirmation(request, undefined, false), false);
	}
	assert.throws(() => validateRequest({ mode: "act", app: "Terminal", task: "run command" }, "safe"), PolicyError);
	const fullAlias = validateRequest({ mode: "inspect", app: "Friendly Alias" }, "full-permissions");
	assert.doesNotThrow(() => validateResolvedAppIdentity(fullAlias, "com.apple.MobileSMS", false));
	assert.throws(() => validateRequest({ mode: "act", app: "App", task: "x\u0000y" }, "full-permissions"), PolicyError);
	assert.throws(
		() =>
			validateRequest(
				{ mode: "act", app: "App", task: "do it", cleanup: false, cleanup_instructions: "restore it" },
				"full-permissions",
			),
		PolicyError,
	);
});
