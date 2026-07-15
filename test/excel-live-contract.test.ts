import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedTools = [
	"read_ranges",
	"search_workbook",
	"list_items",
	"write_range",
	"clear_range",
	"update_sheet",
	"update_workbook",
	"copy_range_to",
	"read_range_image",
	"run_officejs",
	"read_sheets_metadata",
	"resize_range",
	"update_sheet_view",
	"format_range",
	"chart",
	"table",
	"pivot_table",
];

test("captured Excel registry contract preserves all 17 exact versioned schemas", async () => {
	const bytes = await readFile(new URL("../docs/excel-live-tool-schemas.json", import.meta.url));
	assert.equal(
		createHash("sha256").update(bytes).digest("hex"),
		"85039a479270294b8a8dd780c6048bc49a87aa4c3e3ebb8b11695a46136e3709",
	);

	const capture = JSON.parse(bytes.toString("utf8"));
	assert.deepEqual(capture.tool_schemas.map((tool: { tool_name: string }) => tool.tool_name), expectedTools);
	for (const tool of capture.tool_schemas) {
		assert.equal(tool.surface, "excel");
		assert.equal(tool.version, "1");
		assert.equal(typeof tool.description, "string");
		assert.equal(tool.input_schema.type, "object");
	}
});

test("captured Excel live probe preserves discovery, read-back, and cleanup evidence", async () => {
	const bytes = await readFile(new URL("../docs/excel-live-probe.json", import.meta.url));
	assert.equal(
		createHash("sha256").update(bytes).digest("hex"),
		"56ebaf958c0e18529a63e86216e7aa135faeae4bff6987b4ec0e83ec1aa55be8",
	);

	const capture = JSON.parse(bytes.toString("utf8"));
	assert.equal(capture.discovery.surface, "excel");
	assert.equal(capture.discovery.document_title, "Target Companies.xlsx");
	assert.equal(capture.discovery.status, "connected");
	assert.deepEqual(
		capture.discovery.supported_tools.map((tool: { name: string }) => tool.name),
		expectedTools,
	);
	assert.ok(capture.discovery.supported_tools.every((tool: { version: string }) => tool.version === "1"));

	const readBack = capture.commands.find((command: { logical_step: string }) => command.logical_step === "read_probe_value");
	assert.equal(readBack.status, "succeeded");
	assert.equal(readBack.exact_read_back_value, "codex-document-control-probe-7f3a9c2e");

	const write = capture.commands.find((command: { logical_step: string }) => command.logical_step === "write_probe_value");
	assert.equal(write.idempotency_key, "probe-7f3a9c2e-03-write-a1");
	assert.equal(write.terminal_result_captured, false);
	assert.equal(write.effect_verified_by_command_id, readBack.command_id);

	assert.equal(capture.cleanup.verified_absent, true);
	assert.deepEqual(capture.cleanup.remaining_sheets, ["Sheet1"]);
});
