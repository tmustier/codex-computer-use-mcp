import assert from "node:assert/strict";
import test from "node:test";

// The macOS app-server transport fixtures rely on process groups, pgrep and lsof.
const macTest = process.platform === "darwin" ? test : test.skip;
import { z } from "zod";
import { callOfficialDirectTool } from "../src/direct-broker.ts";

macTest("official signed broker completes a real Computer Use call", async () => {
	const result = await callOfficialDirectTool("list_apps", {});
	assert.equal(result.isError, false);
	assert.equal(result.brokerCleanupVerified, true);
	assert.equal(result.modelTurnsStarted, 0);
	assert.equal(result.ephemeralThread, true);
	const textBlock = z.object({ type: z.literal("text"), text: z.string() });
	assert.ok(result.content.some((block) => textBlock.safeParse(block).success));
});
