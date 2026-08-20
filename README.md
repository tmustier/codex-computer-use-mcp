# Codex Computer Use MCP

This package exposes the official signed macOS Computer Use capabilities as direct typed tools for Pi and MCP clients. The calling agent chooses every tool and argument itself.

The primary path has:

- no nested model call;
- no model-generated action plan;
- no subagent;
- no prompt sent to Codex;
- no separate model-token usage.

It does use OpenAI's signed `codex app-server` as the official host for the bundled Computer Use MCP client. The current official `mcpServer/tool/call` API requires a loaded thread identifier, so the bridge requests an ephemeral, zero-turn context and requires a usable thread ID. It never calls `turn/start` and fails closed if any `turn/*` or `item/*` model activity appears.

> **Independent project.** This is not an OpenAI product and is not endorsed by OpenAI. The app-server API is marked experimental and ChatGPT's reviewed component locations may change.

## Direct tools

Pi registers namespaced tools to avoid collisions with Pi's built-ins. The MCP server exposes the upstream method names.

| Pi tool | MCP method | No-permissions | Purpose |
|---|---|---:|---|
| `computer_use_list_apps` | `list_apps` | yes | List running and recently used apps |
| `computer_use_get_app_state` | `get_app_state` | yes | Read the key-window screenshot and accessibility tree |
| `computer_use_click` | `click` | yes | Click an element or screenshot coordinates |
| `computer_use_perform_secondary_action` | `perform_secondary_action` | yes | Invoke a named accessibility action |
| `computer_use_set_value` | `set_value` | yes | Assign an accessibility value |
| `computer_use_select_text` | `select_text` | yes | Select text or place the cursor |
| `computer_use_scroll` | `scroll` | yes | Scroll an element |
| `computer_use_drag` | `drag` | yes | Drag between screenshot coordinates |
| `computer_use_press_key` | `press_key` | yes | Send a key or key combination |
| `computer_use_type_text` | `type_text` | yes | Type literal text |

The MCP and Pi façades provide typed definitions for the ten current Computer Use methods. They accept additional arguments so compatible upstream additions can pass through. Harmless changes to the signed helper's descriptions, annotations or schema metadata do not block calls. The official service remains authoritative when it executes a request.

Pi registers and activates all ten definitions together in every fresh session, while preserving active tools owned by Pi and other extensions. This prevents interaction methods from being absent or loaded through an incompatible provider binding.

Pi—not a nested planner—calls `computer_use_get_app_state` before interacting with an app, then chooses and executes as many actions as the task needs. The adapter retains the verified app-server runtime and signed Computer Use client across the complete matching-app-selector sequence, preserving the official app-use session and element identifiers. It closes and verifies the retained process tree when the agent settles, another inspection using that selector replaces it, an error occurs, or Pi shuts down.

## Authorization policy: durable no-permissions

`no-permissions` has one precise meaning here: **the wrapper asks no permission questions and exposes all ten official actions**. It is the only mode and the durable default. There is no safe/full selector, config file, environment override, slash command, CLI switch, per-call elevation, app allowlist, intent classifier, task schema, per-action confirmation, special-case app policy, or method gate.

The app-server runtime uses the official Full access combination: `approvalPolicy: "never"` and `sandbox: "danger-full-access"`. In the pinned Codex host, that maps to a disabled permission profile and automatically accepts empty-schema MCP approval elicitations. Normal Computer Use app-access checks therefore proceed without a per-app prompt, just as they do in Codex Full access. The bridge does not edit the service's persistent per-bundle approval file. If app-server emits an elicitation instead of resolving it under Full access, the bridge still forwards it faithfully to the invoking client; unsupported clients return `cancel`, never a fabricated `accept` or `decline`.

No-permissions leaves the official and transport requirements unchanged:

- macOS Screen Recording, Accessibility, and TCC controls remain authoritative;
- the adapter still selects and verifies the official signed components required for the supported transport;
- unsupported calls surface the official service's own error instead of failing an independent schema-fidelity gate.

App names, paths, bundle identifiers, key expressions, and compatible additional arguments pass to the official service unchanged. The adapter has no app allowlist, canonical app rewrite, same-app lock, or focus gate. Process cleanup and metadata-only audit remain operational behavior, not authorization or sandbox boundaries.

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
- Pi 0.80.7 or newer
- official ChatGPT macOS app at `/Applications/ChatGPT.app`
- official Computer Use component installed by ChatGPT under `~/.codex/computer-use/`

The bridge follows ChatGPT's current launcher contract for `SkyComputerUseClient` under that per-user component directory. It does not honor `HOME`, `CODEX_HOME`, or an arbitrary path override when resolving the production client. The former exact app-in-plugin layout remains a strict compatibility candidate only when the current component is absent. Every selected client must be at a canonical reviewed path, pass strict code-signature verification, and carry OpenAI Team ID `2DC432GLL2`.

The direct bridge starts app-server with a new private `CODEX_HOME` containing no account credentials and only one configured MCP server: official Computer Use. It does not inherit the user's Codex MCP servers, plugins, history, memories, API keys, or auth file. It selects a non-websocket dummy model provider bound to unreachable loopback, disables plugin/remote-control features, and never starts a turn; this prevents app-server model prewarm or Responses API traffic.

### Locked-screen limitation

Direct local calls require an unlocked macOS session. Window and accessibility actions can fail with official error `-10005` after the Mac locks.

OpenAI's [locked Computer Use](https://developers.openai.com/codex/app/computer-use#use-computer-use-while-your-mac-is-locked) requires an active, trusted ChatGPT turn started from a connected device. It does not authorize other apps or local processes to unlock the Mac. This package cannot support locked local use unless OpenAI provides a supported local authorization API.

## Pi integration

Install from npm:

```bash
pi install npm:codex-computer-use-mcp
```

To evaluate a source checkout instead:

```bash
npm ci
npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

Command:

```text
/computer-use-status
```

The native Pi adapter is the primary product path. It registers and activates all ten typed tools directly, and routes `get_app_state` plus subsequent actions using the same app selector through one retained signed-client session. It exposes no mode-changing command or wrapper-generated approval UI. Official app-access approval elicitations are resolved by Codex Full access before they reach Pi. Any elicitation that app-server does emit is shown through Pi's UI, and only the user's choice is returned to the service.

## MCP server

Running the binary without arguments starts a stdio MCP server exposing the same ten direct methods plus `computer_use_status`:

```bash
node dist/mcp-server.js
```

For Claude Code, install the package in a dedicated directory and register its binary:

```bash
install_dir="$HOME/.local/share/codex-computer-use-mcp"
mkdir -p "$install_dir"
npm install --prefix "$install_dir" --save-exact codex-computer-use-mcp
claude mcp add --scope user codex-computer-use -- \
  "$install_dir/node_modules/.bin/codex-computer-use-mcp"
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

The generic MCP server exposes the same no-permissions behavior: official Codex Full access, no wrapper permission gate, and all ten methods. Sequential calls using the same app selector reuse one official app-use session; inactive sessions close after two minutes or when the MCP connection closes. App-access approvals are resolved inside the official host. Any standard form or URL elicitation that app-server emits is forwarded as an MCP `elicitation/create` request. The upstream client response is returned unchanged; unsupported or headless clients cancel rather than fabricate a decision.

## Execution and privacy

For each direct call, the adapter:

1. validates the known typed arguments while preserving additional fields;
2. applies the single durable no-permissions policy with no mode or prompt branch;
3. passes app selectors and key expressions through unchanged;
4. verifies fixed OpenAI-signed broker/client binaries when starting a session;
5. starts a credential-free isolated app-server process tree with model transport disabled;
6. starts an ephemeral thread and requires a usable thread ID;
7. issues one `mcpServer/tool/call` without a separate schema-fidelity gate;
8. rejects any model-turn notification, including during teardown;
9. retains the official session for composition, then combines partial-preserving ancestry enumeration with private-working-directory ownership recovery to terminate and verify every owned process;
10. removes temporary broker state and writes a content-safe audit.

Foreground apps are allowed. The adapter neither forces nor prevents focus changes, and it does not monitor focus.

Tool results may contain visible target-app text or screenshots because that is the purpose of Computer Use. They return to the invoking Pi/MCP client. Pi truncates text at 50KB or 2,000 lines to protect model context; when truncation occurs, it writes the complete text to a mode-0600 file in a private directory under `/tmp` and includes that path in the result. Image data is never spilled. Audits never retain arguments, typed values, screenshots, app-state payloads, result text, prompts, credentials, or tokens—only bounded metadata such as method, hashed app identity, byte counts, content types, outcome, broker version, and zero-turn evidence.

## State and migration

Audit state defaults to `~/.direct-computer-use`; override with `CODEX_COMPUTER_USE_HOME`. Permission policy is not read from that agent-writable path: no-permissions is compiled as the only interface. Legacy `config.json` files are ignored.

See [`MIGRATION.md`](MIGRATION.md) for version 0.1 migration, source acceptance, rollback, and conflict avoidance.

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

`package-lock.json` gives source checkouts and CI reproducible dependency versions. Published consumers use standard npm dependency resolution.

See [`CHANGELOG.md`](CHANGELOG.md), [`PROOF.md`](PROOF.md), [`SECURITY.md`](SECURITY.md), and [`CONTRIBUTING.md`](CONTRIBUTING.md). Agent contributors must also follow [`AGENTS.md`](AGENTS.md). It records the maintainer's thin-adapter intent and review standard.

## License

MIT
