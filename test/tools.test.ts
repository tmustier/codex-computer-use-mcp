import assert from "node:assert/strict";
import test from "node:test";
import { OFFICIAL_METHODS, OFFICIAL_TOOL_METADATA, normalizeKeyExpression, validateDirectArguments } from "../src/tools.ts";

test("common Pi key aliases normalize to the official xdotool-style key table", () => {
	assert.equal(normalizeKeyExpression("CMD+A"), "Meta_L+a");
	assert.equal(normalizeKeyExpression("Command+Shift+S"), "Meta_L+Shift_L+s");
	assert.equal(normalizeKeyExpression("CTRL+ALT+Delete"), "Control_L+Alt_L+Delete");
	assert.equal(normalizeKeyExpression("Escape"), "Escape");
	assert.deepEqual(validateDirectArguments("press_key", { app: "TextEdit", key: "CMD+A" }), {
		app: "TextEdit",
		key: "Meta_L+a",
	});
	assert.deepEqual(validateDirectArguments("click", { app: "TextEdit" }), { app: "TextEdit" });
});

test("official action metadata does not conflate mutation with destruction", () => {
	for (const method of OFFICIAL_METHODS) {
		assert.equal(OFFICIAL_TOOL_METADATA[method].annotations.destructiveHint, false);
	}
});
