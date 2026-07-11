# Pi adapters

Choose **one** integration path. Do not load both under the same tool name.

## Native Pi package adapter

```bash
pi install npm:codex-computer-use-mcp@0.1.0
```

The package manifest loads `integrations/pi/index.ts`. It registers:

- `background_computer_use`
- `/background-computer-use-status`
- `/background-computer-use-mode`

This is the best Pi experience because safe-mode confirmation uses Pi's native `ctx.ui.confirm` dialog. The adapter imports the same compiled service used by the MCP server; it does not fork the security-critical runner or policy.

For a local checkout:

```bash
npm ci && npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

`-ne` avoids a duplicate-tool conflict if another copy is already installed.

## Pi MCP gateway

Merge the `codex-computer-use` entry from [`mcp.json.example`](mcp.json.example) into `~/.pi/agent/mcp.json`, then reload Pi.

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

The stdio server defaults to safe mode. The MCP path needs form-elicitation support for safe-mode `inspect` and `act`; otherwise those calls fail closed. `list` and constrained `dictionary_lookup` remain available. Full-permissions mode must be enabled separately and explicitly with the CLI described in the repository README.

Do not register the app-bundled Codex broker itself as a direct tool. This wrapper is the policy, focus, lock, cleanup, and audit boundary.
