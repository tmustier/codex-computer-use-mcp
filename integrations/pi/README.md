# Pi integration

The native Pi adapter is the primary 0.2 path. It registers ten namespaced typed tools so Pi itself chooses each official Computer Use method and argument.

## Source checkout acceptance

```bash
npm ci
npm run build
CODEX_COMPUTER_USE_HOME="$(mktemp -d)" \
  pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

`-ne` prevents an installed 0.1 adapter from loading at the same time. This source workflow does not install or switch live Pi configuration.

For normal installation, use the exact version 0.2.0 npm package:

```bash
pi install npm:codex-computer-use-mcp@0.2.0
```

Use the source workflow only when you need to test an exact reviewed commit. Follow the rollback procedure in `MIGRATION.md` when replacing version 0.1.

## Registered surface

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
- `/computer-use-status`

No-permissions is the only policy: all ten tools are available with no wrapper permission prompts, mode selector, or app/intent/action gate. Pi advertises support for signed Computer Use elicitations and renders form, OpenAI-form, and URL requests through its UI. The user's `accept`, `decline`, or `cancel` response is returned to the service; the adapter never fabricates or silently answers one.

## Generic MCP gateway

Merge `mcp.json.example` only for the exact 0.2.0 package or after building an exact reviewed source commit. `directTools: false` is intentional; it keeps this powerful generic MCP surface behind Pi's gateway.

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

The generic MCP path uses the same durable no-permissions policy: all ten methods and no wrapper permission gate. Standard form and URL elicitations are forwarded to the invoking MCP client; an unsupported or headless client returns `cancel` rather than a fabricated decline.

See the root `MIGRATION.md` before replacing an installed 0.1 adapter.
