import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EXPECTED_OFFICIAL_INPUT_SCHEMAS, OFFICIAL_METHODS, OFFICIAL_TOOL_METADATA } from "../src/tools.ts";

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
		"must not be used",
		"credentials",
		"authentication",
		"payments",
		"external messages",
		"destructive actions",
		"purpose-built",
		"confirmation",
		"policy gate",
	]) {
		assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	}
	assert.match(source, /OFFICIAL_TOOL_METADATA\[method\]\.description/);
	assert.match(source, /executeDirectTool/);
	assert.match(source, /Call computer_use_get_app_state once per assistant turn before interacting with an app/);
});

test("Pi runtime registration exposes the exact official contract for all ten tools", async () => {
	const { default: adapter } = await import("../integrations/pi/index.ts");
	const tools: Array<{ name: string; description: string; parameters: unknown; promptGuidelines: string[] }> = [];
	const commands: string[] = [];
	adapter({
		registerTool(tool: { name: string; description: string; parameters: unknown; promptGuidelines: string[] }) { tools.push(tool); },
		registerCommand(name: string) { commands.push(name); },
	} as any);
	assert.deepEqual(commands, ["computer-use-status"]);
	assert.deepEqual(tools.map((tool) => tool.name).sort(), OFFICIAL_METHODS.map((method) => `computer_use_${method}`).sort());
	for (const method of OFFICIAL_METHODS) {
		const tool = tools.find((item) => item.name === `computer_use_${method}`)!;
		assert.equal(tool.description, OFFICIAL_TOOL_METADATA[method].description);
		assert.deepEqual(tool.parameters, EXPECTED_OFFICIAL_INPUT_SCHEMAS[method]);
	}
});
