import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OFFICIAL_METHODS } from "../src/tools.ts";

test("Pi adapter registers all ten tools through one no-permissions path with no prompt or mode route", async () => {
	const source = await readFile("integrations/pi/index.ts", "utf8");
	assert.match(source, /const piName = `computer_use_\$\{method\}`/);
	for (const method of OFFICIAL_METHODS) assert.match(source, new RegExp(`\\b${method}: Type\\.Object`));
	for (const forbidden of [
		"runOfficialCodex",
		"buildPrompt",
		"reasoningEffort",
		"gpt-",
		"background_computer_use",
		"computer-use-mode",
		"saveConfig",
		"loadConfig",
		"onElicitation",
		"handleElicitation",
		"ctx.ui.confirm",
		"ctx.ui.select",
		"ctx.ui.input",
		"full-permissions",
		"safe mode",
	]) {
		assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	}
	assert.match(source, /unrestricted no-permissions interface/);
	assert.match(source, /no wrapper approval prompt/);
	assert.match(source, /executeDirectTool/);
	assert.match(source, /computer_use_get_app_state/);
});

test("Pi runtime registration exposes exactly status plus all ten tools", async () => {
	const { default: adapter } = await import("../integrations/pi/index.ts");
	const tools: string[] = [];
	const commands: string[] = [];
	adapter({
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand(name: string) { commands.push(name); },
	} as any);
	assert.deepEqual(commands, ["computer-use-status"]);
	assert.deepEqual(tools.sort(), OFFICIAL_METHODS.map((method) => `computer_use_${method}`).sort());
});
