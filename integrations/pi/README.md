# Pi integration

The native Pi adapter is the primary 0.3 path. It registers ten namespaced typed tools so Pi itself chooses each official Computer Use method and argument. Pi 0.80.7 or newer exposes them progressively without changing the ten-tool contract.

## Source checkout acceptance

```bash
npm ci
npm run build
CODEX_COMPUTER_USE_HOME="$(mktemp -d)" \
  pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

`-ne` prevents an installed 0.1 adapter from loading at the same time. This source workflow does not install or switch live Pi configuration.

For normal installation, use the exact version 0.3.0 npm package:

```bash
pi install npm:codex-computer-use-mcp@0.3.0
```

Use the source workflow only when you need to test an exact reviewed commit. Follow the rollback procedure in `MIGRATION.md` when replacing version 0.1.

## Registered surface

Initially active:

- `computer_use_list_apps`
- `computer_use_get_app_state`

Registered and activated after a successful `get_app_state` call:

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

The session-start narrowing preserves every active tool owned by Pi or another extension. Activation after inspection is purely additive: both inspection tools remain active, and the adapter does not remove or replace any tool in that call. The lazily activated tools rely on their official descriptions and omit `promptSnippet` and `promptGuidelines`, so native deferred schema loading does not rebuild the system prompt. Supported Anthropic and OpenAI models receive the definitions at the inspection result; other models receive Pi's normal active-tool fallback on the next request.

No-permissions is the only policy: all ten tools are registered and available through this lifecycle with no wrapper permission prompts, mode selector, or app/intent/action gate. The signed host runs with Codex Full access (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`), so normal empty-schema Computer Use app approvals are accepted by Codex before they reach Pi. Pi renders any form, OpenAI-form, or URL elicitation app-server does emit. The user's `accept`, `decline`, or `cancel` response is returned unchanged; the adapter never fabricates one.

## Generic MCP gateway

Merge `mcp.json.example` only for the exact 0.3.0 package or after building an exact reviewed source commit. `directTools: false` is intentional; it keeps this powerful generic MCP surface behind Pi's gateway.

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
