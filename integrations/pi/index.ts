import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { computerUseStatus, selectComputerUseRoute, type ComputerUseRoute } from "../../src/direct-service.ts";
import { DirectSessionExecutor } from "../../src/session-executor.ts";
import type { CuaReplTool, JsonObject } from "../../src/tools.ts";
import { handleOfficialElicitation, openUrl, toPiContent } from "./content.ts";
import { registerLegacyComputerUse, type LegacyComputerUseSession } from "./legacy.ts";

export { handleOfficialElicitation, toPiContent } from "./content.ts";

const jsonObjectSchema = z.record(z.string(), z.json());

/** Pi tool names for the official cua_repl tools. The official instructions call `js` "cua_repl". */
export const PI_TOOL_NAMES = { js: "cua_repl", js_reset: "cua_repl_reset" } as const satisfies Record<CuaReplTool, string>;

type ComputerUseSession = Pick<DirectSessionExecutor, "execute" | "endTurn" | "close">;

interface DirectComputerUseOptions {
  session?: ComputerUseSession;
  legacySession?: LegacyComputerUseSession;
  /** Test-only route override. */
  route?: ComputerUseRoute;
}

export default async function directComputerUse(pi: ExtensionAPI, options: DirectComputerUseOptions = {}) {
  const stateRoot = process.env.CODEX_COMPUTER_USE_HOME || path.join(getAgentDir(), "direct-computer-use");
  const route = options.route ?? await selectComputerUseRoute(stateRoot);

  pi.registerCommand("computer-use-status", {
    description: "Show Computer Use status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(computerUseStatus(route, stateRoot), null, 2), "info");
    },
  });

  if (route.kind === "legacy") {
    registerLegacyComputerUse(pi, stateRoot, options.legacySession);
    return;
  }
  const session = options.session ?? new DirectSessionExecutor();
  for (const tool of route.official.tools) {
    pi.registerTool({
      name: PI_TOOL_NAMES[tool.name],
      label: tool.name === "js" ? "Computer Use" : "Computer Use reset",
      description: tool.description,
      // SAFETY: Pi accepts standard JSON Schema objects as custom-tool parameter schemas.
      parameters: tool.inputSchema as any,
      annotations: tool.annotations,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const response = await session.execute(tool.name, jsonObjectSchema.parse(params), {
          stateRoot,
          signal,
          supportsOpenAiFormElicitation: true,
          onElicitation: (request) => handleOfficialElicitation(
            request,
            ctx,
            (url) => openUrl(pi, url, signal),
          ),
        });
        const rendered = await toPiContent(response.content);
        const details: JsonObject = {};
        if (rendered.fullOutputPath) details.fullOutputPath = rendered.fullOutputPath;
        return { content: rendered.content, details, isError: response.isError };
      },
    });
  }

  // ChatGPT ends a cua_repl turn from its Stop hook; REPL bindings survive into the next turn.
  pi.on("agent_settled", () => session.endTurn());
  pi.on("session_shutdown", () => session.close());
}
