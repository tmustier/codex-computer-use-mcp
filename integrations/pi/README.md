# Pi integration

The native Pi adapter is the primary 0.3 path. It registers and activates ten namespaced typed tools together so Pi itself chooses each official Computer Use method and argument.

## Source checkout acceptance

```bash
npm ci
npm run build
CODEX_COMPUTER_USE_HOME="$(mktemp -d)" \
  pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

`-ne` prevents an installed 0.1 adapter from loading at the same time. This source workflow does not install or switch live Pi configuration.

For normal installation, use the exact version 0.3.4 npm package:

```bash
pi install npm:codex-computer-use-mcp@0.3.4
```

Use the source workflow only when you need to test an exact reviewed commit. Follow the rollback procedure in `MIGRATION.md` when replacing version 0.1.

## Registered surface

All ten tools are registered and active from session start:

- `computer_use_list_apps`
- `computer_use_get_app_state`
- `computer_use_click`
- `computer_use_perform_secondary_action`
- `computer_use_set_value`
- `computer_use_select_text`
- `computer_use_scroll`
- `computer_use_drag`
- `computer_use_press_key`
- `computer_use_type_text`

Command:

- `/computer-use-status`

Session-start activation is purely additive and preserves every active tool owned by Pi or another extension. The interaction definitions rely on their official descriptions and omit extra prompt metadata.

A successful `get_app_state` retains its verified app-server runtime, thread, and signed Computer Use client. The following direct interaction uses that same client and official active-app lease, then closes the retained process tree with strict cleanup verification. A new inspection replaces and closes any earlier retained session; Pi `session_shutdown` also closes it.

No-permissions is the only policy: all ten tools are registered and available through this lifecycle with no wrapper permission prompts, mode selector, or app/intent/action gate. The signed host runs with Codex Full access (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`), so normal empty-schema Computer Use app approvals are accepted by Codex before they reach Pi. Pi renders any form, OpenAI-form, or URL elicitation app-server does emit. The user's `accept`, `decline`, or `cancel` response is returned unchanged; the adapter never fabricates one.

## Generic MCP gateway

Merge `mcp.json.example` only for the exact 0.3.4 package or after building an exact reviewed source commit. `directTools: false` is intentional; it keeps this powerful generic MCP surface behind Pi's gateway.

For a source checkout:

```json
{
  "mcpServers": {
    "computer-use-direct-source": {
      "command": "node",
      "args": ["/absolute/path/to/codex-computer-use-mcp/dist/mcp-server.js"],
      "lifecycle": "lazy",
      "requestTimeoutMs": 180000,
      "directTools": false
    }
  }
}
```

Do not load the native adapter and generic MCP adapter into the same acceptance process unless tool names are intentionally isolated.

The generic MCP path uses the same durable no-permissions and official Full access policy: all ten methods and no wrapper permission gate. App-access approvals resolve inside Codex. Any standard form or URL elicitation app-server emits is forwarded to the invoking MCP client; an unsupported or headless client returns `cancel` rather than a fabricated decision.

See the root `MIGRATION.md` before replacing an installed 0.1 adapter.
