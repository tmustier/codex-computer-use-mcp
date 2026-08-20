import assert from "node:assert/strict";
import test from "node:test";
import { COMPUTER_USE_METHODS, TOOL_METADATA, validateDirectArguments } from "../src/tools.ts";

test("tool arguments preserve official key expressions and compatible additional fields", () => {
	assert.deepEqual(validateDirectArguments("press_key", {
		app: "TextEdit",
		key: "CMD+A",
		futureOption: true,
	}), {
		app: "TextEdit",
		key: "CMD+A",
		futureOption: true,
	});
});

test("action metadata does not conflate mutation with destruction", () => {
	for (const method of COMPUTER_USE_METHODS) {
		assert.equal(TOOL_METADATA[method].annotations.destructiveHint, false);
	}
});
