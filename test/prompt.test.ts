import assert from "node:assert/strict";
import test from "node:test";
import { validateRequest } from "../src/policy.ts";
import { buildPrompt } from "../src/prompt.ts";

test("prompt names only the fully-qualified Computer Use tools enabled for each mode", () => {
	const listPrompt = buildPrompt(validateRequest({ mode: "list" }));
	assert.match(listPrompt, /Call computer-use\/list_apps exactly once\./);
	assert.doesNotMatch(listPrompt, /computer-use\/get_app_state/);

	const inspectPrompt = buildPrompt(
		validateRequest({ mode: "inspect", app: "CUA Harness A" }, "full-permissions"),
		"dev.codexcomputeruse.cua-harness-a",
	);
	assert.match(inspectPrompt, /computer-use\/list_apps, computer-use\/get_app_state/);
	assert.match(inspectPrompt, /Target exactly "dev\.codexcomputeruse\.cua-harness-a"/);
	assert.match(inspectPrompt, /set app="CUA Harness A"/);
	assert.doesNotMatch(inspectPrompt, /computer-use\/click/);

	const lookupPrompt = buildPrompt(validateRequest({ mode: "dictionary_lookup", query: "dragon" }, "full-permissions"), "com.apple.Dictionary");
	for (const tool of ["get_app_state", "set_value", "scroll"]) {
		assert.match(lookupPrompt, new RegExp(`computer-use/${tool}`));
	}
	for (const tool of ["click", "perform_secondary_action", "select_text", "drag", "press_key", "type_text"]) {
		assert.doesNotMatch(lookupPrompt, new RegExp(`computer-use/${tool}`));
	}
	assert.match(lookupPrompt, /fixed neutral value "dictionary"/);
	assert.match(lookupPrompt, /Do not click, type, press keys/);

	const actPrompt = buildPrompt(validateRequest({ mode: "act", app: "CUA Harness A", task: "Exercise the harness controls" }, "full-permissions"));
	const fullPrompt = buildPrompt(
		validateRequest({ mode: "act", app: "Terminal", task: "Perform the explicitly requested action" }, "full-permissions"),
	);
	assert.match(fullPrompt, /configured full-permissions mode broadly authorizes/);
	assert.match(fullPrompt, /complete official typed Computer Use methods/);
	assert.doesNotMatch(fullPrompt, /without saving, sending, deleting/);

	for (const tool of [
		"list_apps",
		"get_app_state",
		"click",
		"perform_secondary_action",
		"set_value",
		"select_text",
		"scroll",
		"drag",
		"press_key",
		"type_text",
	]) {
		assert.match(actPrompt, new RegExp(`computer-use/${tool}`));
	}
});
