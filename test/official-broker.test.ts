import assert from "node:assert/strict";
import test from "node:test";
import { callOfficialDirectTool } from "../src/direct-broker.ts";

test("official signed broker completes a real Computer Use call", async () => {
	const result = await callOfficialDirectTool("list_apps", {});
	assert.equal(result.isError, false);
	assert.equal(result.brokerCleanupVerified, true);
	assert.equal(result.modelTurnsStarted, 0);
	assert.equal(result.ephemeralThread, true);
	assert.ok(result.content.some((block) => block.type === "text" && typeof block.text === "string"));
});
