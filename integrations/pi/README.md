# Pi adapters

Choose **one** integration path. Do not load both under the same tool name.

## Native Pi package adapter

```bash
pi install npm:codex-computer-use-mcp@0.1.0
```

The package manifest loads `integrations/pi/index.ts` and registers:

- `background_computer_use`
- `/background-computer-use-status`
- `/background-computer-use-mode`

The adapter imports the same compiled service used by the MCP server; it does not fork the security-critical runner or policy.

For a local checkout:

```bash
npm ci && npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

`-ne` avoids a duplicate-tool conflict if another copy is already installed.

## Pi MCP gateway

Merge [`mcp.json.example`](mcp.json.example) into `~/.pi/agent/mcp.json`, then reload Pi.

`directTools: false` is intentional. It keeps this powerful capability behind Pi's MCP gateway instead of injecting it into every agent turn as an always-on direct tool.

For a local checkout, replace the command and arguments with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/codex-computer-use-mcp/dist/mcp-server.js"],
  "lifecycle": "lazy",
  "requestTimeoutMs": 360000,
  "directTools": false
}
```

## Permission warning

Standalone safe mode is list-only. `inspect`, `act`, and `dictionary_lookup` require explicitly acknowledged full-permissions mode. Full mode broadly authorizes wrapper use of official Computer Use because target checks cannot be placed before signed-client dispatch without breaking official sender authentication. Read the root README before enabling it.

Do not register the app-bundled Codex broker itself as a direct tool. This wrapper provides signing checks, post-dispatch validation, focus monitoring, locking, cleanup criteria, and private audits.
