import { DICTIONARY_NEUTRAL_QUERY, type ValidatedRequest } from "./policy.ts";

export const RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"status",
		"app",
		"mode",
		"summary",
		"cleaned",
		"approvalRequired",
		"usedCapabilities",
		"apps",
		"message",
	],
	properties: {
		status: { type: "string", enum: ["ok", "approval_required", "blocked", "error"] },
		app: { type: "string", maxLength: 500 },
		mode: { type: "string", enum: ["list", "inspect", "act", "dictionary_lookup"] },
		summary: { type: "string", maxLength: 1000 },
		cleaned: { type: "boolean" },
		approvalRequired: { type: "boolean" },
		usedCapabilities: {
			type: "array",
			maxItems: 50,
			items: {
				type: "string",
				enum: [
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
				],
			},
		},
		apps: {
			type: "array",
			maxItems: 100,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "bundleId"],
				properties: {
					name: { type: "string", maxLength: 120 },
					bundleId: { type: "string", maxLength: 160 },
				},
			},
		},
		message: { type: "string", maxLength: 256 },
	},
} as const;

function enabledToolNames(request: ValidatedRequest): string {
	switch (request.mode) {
		case "list":
			return "computer-use/list_apps";
		case "inspect":
			return "computer-use/list_apps, computer-use/get_app_state";
		case "act":
			return [
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
			].map((tool) => `computer-use/${tool}`).join(", ");
		case "dictionary_lookup":
			return ["get_app_state", "set_value", "scroll"].map((tool) => `computer-use/${tool}`).join(", ");
	}
}

function operationInstructions(request: ValidatedRequest, targetApp = request.app): string {
	switch (request.mode) {
		case "list":
			return `Call list_apps exactly once. Return every discovered app as name + bundleId only. Do not include paths, PIDs, titles, windows, or app contents.`;
		case "inspect":
			return `Target only ${JSON.stringify(targetApp)}. Call get_app_state. Use list_apps only if the exact target is rejected and must be resolved. Do not mutate anything. Summarize the target's operational state without reproducing sensitive or unrelated text. Return apps=[].`;
		case "act": {
			const cleanup = request.cleanup
				? request.cleanupInstructions ??
					(request.permissionMode === "full-permissions"
						? "Restore transient state created only for this task, without undoing the requested durable result."
						: "Restore transient controls/content changed by this task to a neutral pre-task state without saving, sending, deleting, or affecting another app.")
				: "Cleanup was disabled; leave the requested target-app result in place.";
			const required = request.requiredCapabilities.length
				? `The following capabilities must genuinely be exercised as part of the task and reported: ${request.requiredCapabilities.join(", ")}.`
				: request.permissionMode === "full-permissions"
					? "Use any of the complete official typed Computer Use methods needed for the task."
					: "Choose the least disruptive Computer Use actions that complete the task.";
			const authorization =
				request.permissionMode === "full-permissions"
					? "The configured full-permissions mode broadly authorizes this wrapper to execute official-service actions without a wrapper per-operation confirmation."
					: "The task has been confirmed in Pi safe mode.";
			return `Target only ${JSON.stringify(targetApp)}. ${authorization} The requested task is: ${JSON.stringify(request.task)}. First call get_app_state, then perform the task using the typed Computer Use tools, then call get_app_state to verify the result. ${required} Cleanup requirement: ${cleanup} ${request.cleanup ? "After observing the task result, perform cleanup and call get_app_state again to verify the cleaned state." : "Do not invent cleanup."} Return apps=[].`;
		}
		case "dictionary_lookup":
			return `Target only ${JSON.stringify(targetApp)}, which must resolve to the Apple-signed system Dictionary app. This is a narrowly authorized local dictionary lookup for ${JSON.stringify(request.query)}. Call get_app_state. Call set_value exactly once on Dictionary's search field with the exact approved query. Call get_app_state to read and summarize the definition; scroll only the definition area vertically by at most three pages if needed. Then call set_value exactly once on the same search field with the fixed neutral value ${JSON.stringify(DICTIONARY_NEUTRAL_QUERY)} and call get_app_state to verify that neutral state. Do not click, type, press keys, invoke secondary actions, drag, raise, activate, save, copy, share, open links, or operate any other control or app. Return apps=[].`;
	}
}

export function buildPrompt(request: ValidatedRequest, canonicalTargetApp?: string): string {
	if (request.mode === "list") {
		return `Call computer-use/list_apps exactly once. Do not call any other tool. Then return the required JSON object with status="ok", app="app inventory", mode="list", cleaned=true, approvalRequired=false, usedCapabilities=["list_apps"], apps containing every discovered name and bundleId only, and a minimal summary/message. Do not include paths, PIDs, titles, windows, app contents, screenshots, tool output, or reasoning.`;
	}
	const targetApp = canonicalTargetApp ?? request.app!;
	return `Use only these fully qualified MCP tools: ${enabledToolNames(request)}. Target exactly ${JSON.stringify(targetApp)} and no other app. Keep it in the background; do not raise, activate, or focus it. Make at most ${request.maxComputerUseCalls} calls.

${operationInstructions(request, targetApp)}

If an official app-approval elicitation is cancelled or unavailable, stop immediately and return status="approval_required", approvalRequired=true, cleaned=false, and only the methods that actually completed. Otherwise return status="ok" only after observing the requested result. In the final JSON, set app=${JSON.stringify(request.app)}. usedCapabilities must exactly list successfully completed Computer Use method names in order, including duplicates; apps must be empty. Return only the required JSON object with a minimal summary/message and no screenshots, paths, PIDs, raw accessibility tree, unrelated content, tool output, or reasoning.`;
}
