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
		"ctx.ui.confirm",
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
	assert.match(source, /onElicitation: \(request\) => handleOfficialElicitation/);
	assert.match(source, /supportsOpenAiFormElicitation: true/);
	assert.match(source, /Call computer_use_get_app_state once per assistant turn before interacting with an app/);
});

test("Pi surfaces an official form elicitation and returns the user's structured response", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	const calls: Array<{ kind: string; value: unknown }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			async select(title: string, options: string[]) { calls.push({ kind: "select", value: { title, options } }); return "Respond"; },
			async editor(title: string, prefill?: string) { calls.push({ kind: "editor", value: { title, prefill } }); return '{"choice":"allow"}'; },
			notify(message: string) { calls.push({ kind: "notify", value: message }); },
		},
	};
	const response = await handleOfficialElicitation({
		mode: "form",
		message: "Choose access",
		requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["allow", "deny"] } } },
	}, ctx, async () => { throw new Error("must not open a URL for form elicitation"); });
	assert.deepEqual(response, { action: "accept", content: { choice: "allow" } });
	assert.equal((calls[0].value as any).title, "Choose access");
	assert.match((calls[1].value as any).title, /Schema:/);
	assert.match((calls[1].value as any).prefill, /"choice": "allow"/);
});

test("Pi preserves opaque OpenAI-form schemas and JSON responses", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	let editorTitle = "";
	const response = await handleOfficialElicitation({
		mode: "openai/form", message: "Official custom form", requestedSchema: ["opaque", { widget: "custom" }],
	}, {
		hasUI: true,
		ui: {
			async select() { return "Respond"; },
			async editor(title: string) { editorTitle = title; return '"completed"'; },
			notify() {},
		},
	}, async () => false);
	assert.match(editorTitle, /\["opaque",\{"widget":"custom"\}\]/);
	assert.deepEqual(response, { action: "accept", content: "completed" });
});

test("Pi URL elicitation opens only after user choice and returns that acceptance", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	const choices = ["Open URL"];
	const opened: string[] = [];
	const response = await handleOfficialElicitation({
		mode: "url", message: "Complete setup", url: "https://example.test/setup", elicitationId: "setup-1",
	}, {
		hasUI: true,
		ui: {
			async select() { return choices.shift(); },
			async editor() { return undefined; },
			notify() {},
		},
	}, async (url) => { opened.push(url); return true; });
	assert.deepEqual(opened, ["https://example.test/setup"]);
	assert.deepEqual(response, { action: "accept" });

	const declined = await handleOfficialElicitation({
		mode: "url", message: "Complete setup", url: "https://example.test/setup", elicitationId: "setup-2",
	}, {
		hasUI: true,
		ui: { async select() { return "Decline"; }, async editor() { return undefined; }, notify() {} },
	}, async () => { throw new Error("declined URL must not open"); });
	assert.deepEqual(declined, { action: "decline" });
});

test("Pi preserves explicit decline and uses cancel when no UI is available", async () => {
	const { handleOfficialElicitation } = await import("../integrations/pi/index.ts");
	const request = { mode: "form", message: "Choose", requestedSchema: { type: "object", properties: {} } };
	const declined = await handleOfficialElicitation(request, {
		hasUI: true,
		ui: { async select() { return "Decline"; }, async editor() { return undefined; }, notify() {} },
	}, async () => true);
	assert.deepEqual(declined, { action: "decline" });
	const headless = await handleOfficialElicitation(request, {
		hasUI: false,
		ui: { async select() { throw new Error("unreachable"); }, async editor() { throw new Error("unreachable"); }, notify() {} },
	}, async () => true);
	assert.deepEqual(headless, { action: "cancel" });
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
