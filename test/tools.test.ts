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

test("wrapper validation adds no limits or enums absent from the official schemas", () => {
	assert.deepEqual(validateDirectArguments("click", {
		app: "TextEdit",
		click_count: 100_000_000_000_000_000_000,
		x: -50,
		y: 2_000_000,
	}), { app: "TextEdit", click_count: 100_000_000_000_000_000_000, x: -50, y: 2_000_000 });
	assert.deepEqual(validateDirectArguments("scroll", {
		app: "TextEdit",
		element_index: "scroll-area",
		direction: "diagonal",
		pages: -2,
	}), { app: "TextEdit", element_index: "scroll-area", direction: "diagonal", pages: -2 });
	assert.deepEqual(validateDirectArguments("type_text", {
		app: "TextEdit",
		text: "x".repeat(25_000),
	}), { app: "TextEdit", text: "x".repeat(25_000) });
});

test("official action metadata does not conflate mutation with destruction", () => {
	for (const method of OFFICIAL_METHODS) {
		assert.equal(OFFICIAL_TOOL_METADATA[method].annotations.destructiveHint, false);
	}
});
