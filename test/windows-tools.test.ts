import assert from "node:assert/strict";
import test from "node:test";
import { MAC_PLATFORM, WINDOWS_PLATFORM, hostPlatform } from "../src/platform.ts";
import { COMPUTER_USE_METHODS } from "../src/tools.ts";
import {
	WINDOWS_COMPUTER_USE_METHODS,
	WINDOWS_TOOL_INPUT_SCHEMAS,
	WINDOWS_TOOL_METADATA,
	validateWindowsArguments,
} from "../src/windows-tools.ts";

const window = { app: "Chrome", id: 7, title: "Tab" };

test("Windows schemas accept official window objects, numeric-string indexes and compatible extra arguments", () => {
	assert.deepEqual(
		validateWindowsArguments("click", { window, element_index: "7", futureOption: true }),
		{ window, element_index: "7", futureOption: true },
	);
	assert.deepEqual(validateWindowsArguments("list_apps", { futureOption: true }), { futureOption: true });
	assert.deepEqual(validateWindowsArguments("get_window", { id: 7 }), { id: 7 });
	assert.deepEqual(
		validateWindowsArguments("scroll", { window, x: 10, y: 20, scrollX: 0, scrollY: -3 }),
		{ window, x: 10, y: 20, scrollX: 0, scrollY: -3 },
	);
	assert.throws(() => validateWindowsArguments("scroll", { window, x: 10, y: 20 }));
	assert.throws(() => validateWindowsArguments("get_window_state", { app: "Chrome" }));
	assert.throws(() => validateWindowsArguments("click", { window: { app: "Chrome" } }));
});

test("Windows tool tables cover every official method", () => {
	for (const method of WINDOWS_COMPUTER_USE_METHODS) {
		assert.equal(WINDOWS_TOOL_INPUT_SCHEMAS[method].type, "object", method);
		assert.ok(WINDOWS_TOOL_METADATA[method].description.length > 0, method);
	}
	const readOnly = WINDOWS_COMPUTER_USE_METHODS.filter((method) => WINDOWS_TOOL_METADATA[method].annotations.readOnlyHint);
	assert.deepEqual(readOnly, ["list_apps", "list_windows", "get_window", "get_window_state"]);
});

test("platform profiles select the host transport and its method set", () => {
	assert.deepEqual(MAC_PLATFORM.methods, COMPUTER_USE_METHODS);
	assert.deepEqual(WINDOWS_PLATFORM.methods, WINDOWS_COMPUTER_USE_METHODS);
	assert.equal(MAC_PLATFORM.opensSession("get_app_state"), true);
	assert.equal(MAC_PLATFORM.opensSession("click"), false);
	assert.equal(WINDOWS_PLATFORM.opensSession("list_apps"), true);
	assert.equal(WINDOWS_PLATFORM.isMethod("get_app_state"), false);
	assert.equal(MAC_PLATFORM.isMethod("get_window_state"), false);
	assert.equal(hostPlatform().name, process.platform === "win32" ? "windows" : "mac");
});
