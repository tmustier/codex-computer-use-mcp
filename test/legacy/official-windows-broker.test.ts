import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { callOfficialWindowsTool } from "../../src/legacy/windows-sky-broker.ts";

// Live acceptance against the signed helper installed by the Codex app.
const windowsTest = process.platform === "win32" && existsSync(path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node")) ? test : test.skip;

windowsTest("official signed Windows helper completes a real list_apps call", async () => {
	const result = await callOfficialWindowsTool("list_apps", {});
	assert.equal(result.isError, false);
	assert.equal(result.brokerCleanupVerified, true);
	assert.equal(result.modelTurnsStarted, 0);
	assert.match(result.brokerVersion, /^@oai\/sky \d/);
	const apps = z.object({ apps: z.array(z.object({ id: z.string() })) }).parse(result.structuredContent);
	assert.ok(apps.apps.length > 0);
	const textBlock = z.object({ type: z.literal("text"), text: z.string() });
	assert.ok(result.content.some((block) => textBlock.safeParse(block).success));
});
