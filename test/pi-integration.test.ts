import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OFFICIAL_METHODS } from "../src/tools.ts";

test("Pi adapter registers every official capability as a direct typed tool with no nested planner path", async () => {
	const source = await readFile("integrations/pi/index.ts", "utf8");
	assert.match(source, /const piName = `computer_use_\$\{method\}`/);
	for (const method of OFFICIAL_METHODS) assert.match(source, new RegExp(`\\b${method}: Type\\.Object`));
	for (const forbidden of ["runOfficialCodex", "buildPrompt", "reasoningEffort", "gpt-", "model-token usage is involved. Calls consume", "background_computer_use"]) {
		assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	}
	assert.match(source, /executeDirectTool/);
	assert.match(source, /handleElicitation/);
	assert.match(source, /action: "decline"/);
	assert.match(source, /choices\.length > 50/);
	assert.match(source, /value\.length > Number\(maxLength\)/);
	assert.match(source, /Math\.abs\(parsed\) > 1_000_000_000/);
	assert.ok((source.match(/timeout: 60_000/g) ?? []).length >= 3);
	assert.match(source, /explicitTimedConfirmation/);
	assert.match(source, /controller\.signal\.aborted \? undefined : answer/);
	assert.match(source, /computer_use_get_app_state/);
});
