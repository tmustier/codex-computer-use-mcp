import assert from "node:assert/strict";
import test from "node:test";
import { validateDirectArguments } from "../src/tools.ts";

test("tool schemas preserve official key expressions and additional fields", () => {
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
