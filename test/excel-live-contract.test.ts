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
