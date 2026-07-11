# Codex Computer Use MCP

> **0.2 direct candidate:** direct Pi-owned Computer Use tools. The package/repository name is unchanged; npm 0.1 remains the released nested implementation until a separate release gate.

This project exposes the official signed macOS Computer Use capabilities as **direct typed tools** for Pi and MCP clients. The calling agent chooses every tool and argument itself.

The primary path has:

- no nested model call;
- no model-generated action plan;
- no subagent;
- no prompt sent to Codex;
- no separate model-token usage.

It does use OpenAI's signed `codex app-server` as the official host for the bundled Computer Use MCP client. The current official `mcpServer/tool/call` API requires a loaded thread identifier, so the bridge creates an empty, in-memory, zero-turn context (`ephemeral: true`, `turns: []`, `path: null`). It never calls `turn/start` and fails closed if any `turn/*` or `item/*` model activity appears.

> **Independent project.** This is not an OpenAI product and is not endorsed by OpenAI. The app-server API is marked experimental and fixed ChatGPT bundle paths may change.

## Direct tools

Pi registers namespaced tools to avoid collisions with Pi's built-ins. The MCP server exposes the upstream method names.

| Pi tool | MCP method | Safe mode | Purpose |
|---|---|---:|---|
| `computer_use_list_apps` | `list_apps` | yes | List apps known to official Computer Use |
| `computer_use_get_app_state` | `get_app_state` | yes | Read accessibility state and imagery for one app |
| `computer_use_click` | `click` | no | Click an element or screenshot coordinates |
| `computer_use_perform_secondary_action` | `perform_secondary_action` | no | Invoke a named accessibility action |
| `computer_use_set_value` | `set_value` | no | Assign an accessibility value |
| `computer_use_select_text` | `select_text` | no | Select text or place the cursor |
| `computer_use_scroll` | `scroll` | no | Scroll an element |
| `computer_use_drag` | `drag` | no | Drag between screenshot coordinates |
| `computer_use_press_key` | `press_key` | no | Send a key or key combination |
| `computer_use_type_text` | `type_text` | no | Type literal text |

Pi—not a nested planner—must call `computer_use_get_app_state`, choose a current element identifier or coordinates, execute one action, and inspect again when needed.

## Authorization modes

### Safe mode (default)

Safe mode permits only the two read methods: `list_apps` and `get_app_state`. The other eight tools are rejected and metadata-audited before target resolution, process spawn, or official dispatch.

### Full-permissions mode

Full mode enables the complete official ten-tool surface with arbitrary resolvable app targets and typed official actions. It adds no wrapper app allowlist, intent classifier, task schema, per-action confirmation, special-case app policy, or method gate.

Enable only with explicit acknowledgement:

```bash
codex-computer-use-mcp --configure full-permissions --acknowledge-full-permissions
```

Return to safe mode:

```bash
codex-computer-use-mcp --configure safe
```

Full mode does **not** bypass:

- first-party OpenAI app approvals or sensitive-action prompts;
- macOS Screen Recording, Accessibility, or TCC controls;
- strict OpenAI Team ID and code-signature checks;
- exact upstream ten-tool schema verification;
- canonical app identity resolution and per-user/per-app kernel locks shared across Pi and MCP state roots;
- focus telemetry, timeouts, verified process-tree cleanup, or private audit logging.

## Why the signed app-server is required

Calling the signed `SkyComputerUseClient mcp` binary directly from an ordinary Pi/Node parent successfully initializes and lists all ten schemas, but real calls are rejected with:

```text
Computer Use server error -10000: Sender process is not authenticated
```

OpenAI's app-server exposes a documented `mcpServer/tool/call` endpoint. That endpoint calls a configured MCP tool directly; no model turn is required. Running it from the signed app-bundled binary preserves the official responsible-process/authentication chain without injection, re-signing, TCC changes, private socket emulation, or credential extraction.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for source links and the full restriction inventory.

## Requirements

- macOS
- Node.js 22 or newer
- official ChatGPT macOS app at `/Applications/ChatGPT.app`
- official Computer Use component installed and its first-party permissions configured

The direct bridge starts app-server with a new private `CODEX_HOME` containing no account credentials and only one configured MCP server: official Computer Use. It does not inherit the user's Codex MCP servers, plugins, history, memories, API keys, or auth file. It selects a non-websocket dummy model provider bound to unreachable loopback, disables plugin/remote-control features, and never starts a turn; this prevents app-server model prewarm or Responses API traffic.

## Pi integration

The npm package remains at the released 0.1 nested architecture; do not assume an npm 0.2 exists. To evaluate an exact reviewed source commit:

```bash
npm ci
npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

Commands:

```text
/computer-use-status
/computer-use-mode safe
/computer-use-mode full-permissions
```

The native Pi adapter is the primary product path. It registers all ten typed tools directly and can present supported first-party elicitation forms in Pi's UI. It never self-accepts them; unsupported or headless elicitations are declined.

## MCP server

Running the binary without arguments starts a stdio MCP server exposing the same ten direct methods plus `computer_use_status`:

```bash
node dist/mcp-server.js
```

For Pi's generic MCP gateway, keep `directTools: false` so this powerful surface remains intentional:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/absolute/path/to/codex-computer-use-mcp/dist/mcp-server.js"],
      "lifecycle": "lazy",
      "requestTimeoutMs": 180000,
      "directTools": false
    }
  }
}
```

The generic MCP server cannot render Pi's native approval UI. It declines downstream elicitations; configure persistent first-party app approvals only in the official ChatGPT Computer Use settings.

## Security and privacy

Each call:

1. validates typed arguments;
2. enforces safe/full mode before dispatch;
3. resolves a target to a canonical installed bundle ID;
4. acquires a fixed per-user/per-app kernel lock shared across all supported clients and state roots;
5. starts global focus telemetry;
6. verifies fixed OpenAI-signed broker/client binaries;
7. starts a credential-free isolated app-server process tree with model transport disabled;
8. requires explicit `ephemeral: true`, `turns: []`, and `path: null` attestation;
9. verifies the exact upstream ten-tool inventory and schemas;
10. issues exactly one `mcpServer/tool/call`;
11. rejects any model-turn notification, including during teardown;
12. freezes, enumerates, terminates, and verifies the app-server plus separately grouped descendants; then removes temporary state, releases the lock, and writes a content-safe audit with separate broker/lease cleanup evidence.

Focus checks are detection/completion criteria, not a preventive macOS sandbox. If the target becomes frontmost, the call is reported as failed even though an individual official action may already have completed.

Tool results may contain visible target-app text or screenshots because that is the purpose of Computer Use. They return only to the invoking Pi/MCP client. Audits never retain arguments, typed values, screenshots, app-state payloads, result text, prompts, credentials, or tokens—only bounded metadata such as method, canonical/hashed app identity, byte counts, content types, outcome, focus, broker version, and zero-turn evidence.

## State and migration

Direct state defaults to `~/.direct-computer-use`; override with `CODEX_COMPUTER_USE_HOME`. Direct mode does not silently reuse the released nested wrapper's state.

See [`MIGRATION.md`](MIGRATION.md) for the immutable-review gate, exact-head opt-in migration, rollback, and conflict avoidance.

## Development

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

Registry dependency tarballs are exact-pinned with integrity and the package includes `npm-shrinkwrap.json`.

See [`PROOF.md`](PROOF.md), [`SECURITY.md`](SECURITY.md), and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
