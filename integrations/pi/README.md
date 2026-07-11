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

After a separately approved release:

```bash
pi install npm:codex-computer-use-mcp@0.2.0
```

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
- `/computer-use-mode safe|full-permissions`

Safe mode enables the two read methods. Full mode enables all ten without wrapper app/intent/action gates.

Pi forwards supported official form elicitations to interactive UI but never accepts them automatically. Unsupported or headless elicitations are declined.

## Generic MCP gateway

Merge `mcp.json.example` only after building or after a separately approved package release. `directTools: false` is intentional; it keeps this powerful generic MCP surface behind Pi's gateway.

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

The generic MCP path cannot render Pi's native approval UI and therefore declines downstream elicitations. Configure persistent app access only through official ChatGPT Computer Use settings.

See the root `MIGRATION.md` before replacing an installed 0.1 adapter.
