# Codex Computer Use MCP

A local MCP server that lets compatible agents use the official, signed Computer Use broker bundled with the OpenAI ChatGPT macOS app.

It exposes all ten typed Computer Use methods while preserving:

- official OpenAI code-signing checks;
- first-party app approvals and sensitive-action prompts;
- macOS Screen Recording and Accessibility permissions;
- a deliberately list-only safe default;
- explicit acknowledgement before broad full-permissions mode;
- per-app kernel locks;
- foreground/focus telemetry with fail-closed background guarantees;
- output schemas, call budgets, timeout and process-group cleanup;
- sanitized, mode-`0600` metadata audits.

> **Independent project.** This is not an OpenAI product and is not endorsed by OpenAI. It depends on implementation details in the macOS ChatGPT app and may need updates when that app changes.

## Important authorization model

The official Computer Use client authenticates its signed parent process. Putting an unsigned local MCP proxy between app-bundled Codex and that client breaks the official sender-authentication boundary. Therefore wrapper checks of a nested model's target and arguments can only observe events **after** the signed client has dispatched them.

This project does not pretend that post-dispatch observation is a preventive sandbox:

- **Safe mode permits only `list`.** No target app or mutation is dispatched.
- **Full-permissions mode broadly authorizes the wrapper to use official Computer Use.** It retains first-party OpenAI/macOS controls and detects target, method, argument, call-budget, focus, and cleanup drift, but detection cannot undo an action already dispatched.

Do not enable full-permissions if you need the wrapper itself to provide a preventive per-app security boundary.

## Requirements

- macOS
- Node.js 22 or newer
- the official ChatGPT macOS app at `/Applications/ChatGPT.app`
- a Codex account/session available to the app-bundled Codex CLI
- required first-party OpenAI app approvals and macOS privacy permissions, completed in their official UI

The server never extracts credentials, re-signs or injects into an app, changes TCC permissions, forges sender authentication, or self-accepts first-party approvals.

## Install

### From npm (after a release is published)

```bash
npm install -g codex-computer-use-mcp
codex-computer-use-mcp --status
```

### From source

```bash
git clone https://github.com/tmustier/codex-computer-use-mcp.git
cd codex-computer-use-mcp
npm ci
npm test
npm run build
node dist/mcp-server.js --status
```

Running `codex-computer-use-mcp` with no arguments starts the stdio MCP server.

## Tools

### `background_computer_use`

| Mode | Purpose | Permission mode |
|---|---|---|
| `list` | List apps visible to official Computer Use | Safe or full |
| `inspect` | Read one app | Full only |
| `act` | Perform a concrete app task | Full only |
| `dictionary_lookup` | Constrained local Apple Dictionary workflow | Full only |

Optional fields include `cleanup`, `cleanup_instructions`, and `required_capabilities`. The latter can require observed successful use of official methods:

`list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `set_value`, `select_text`, `scroll`, `drag`, `press_key`, `type_text`.

### `background_computer_use_status`

Returns the permission mode, state/audit locations, broker verification and version, model, approval boundary, and supported methods.

## Permission modes

### Safe mode (default)

Safe mode is intentionally list-only. Targeted requests are rejected and audited before a Codex worker starts.

### Full-permissions mode

This broadly authorizes targeted official Computer Use operations. It does **not** bypass official OpenAI approvals, sensitive-action prompts, macOS privacy controls, signing checks, focus monitoring, locks, call budgets, timeout cleanup, or audit logging.

Enable it only with explicit acknowledgement:

```bash
codex-computer-use-mcp --configure full-permissions --acknowledge-full-permissions
```

Return to safe mode:

```bash
codex-computer-use-mcp --configure safe
```

State defaults to `~/.codex-computer-use-mcp`. Override it with `CODEX_COMPUTER_USE_HOME`. Configuration is mode `0600` and audited; an audit failure rolls a mode change back.

## MCP client configuration

### Pi native adapter

```bash
pi install npm:codex-computer-use-mcp@0.1.0
```

This registers `background_computer_use`, `/background-computer-use-status`, and `/background-computer-use-mode`.

### Pi MCP gateway

Alternatively add this to `~/.pi/agent/mcp.json`. `directTools: false` keeps the capability intentional instead of injecting it into every turn:

```json
{
  "mcpServers": {
    "codex-computer-use": {
      "command": "npx",
      "args": ["-y", "codex-computer-use-mcp@0.1.0"],
      "lifecycle": "lazy",
      "requestTimeoutMs": 360000,
      "directTools": false
    }
  }
}
```

See [`integrations/pi/`](integrations/pi/). Do not load both Pi adapters under the same tool name.

### Claude Desktop

```json
{
  "mcpServers": {
    "codex-computer-use": {
      "command": "npx",
      "args": ["-y", "codex-computer-use-mcp@0.1.0"]
    }
  }
}
```

For a source checkout, replace `npx` and its arguments with `node` and the absolute path to `dist/mcp-server.js`.

## How it works

```text
MCP client
  → this local server
  → ChatGPT.app's signed app-bundled Codex CLI
  → signed SkyComputerUseClient
  → official Computer Use service
  → target macOS app
```

The nested Codex turn is pinned to `gpt-5.6-sol`; reasoning is `low` for list, `high` for inspect/Dictionary, and `xhigh` for act. It receives a mode-specific tool allowlist, runs with shell/web/remote plugins disabled, and emits a constrained result schema. Streamed events are checked against the requested target, method set, argument constraints, and call budget. These checks are detection and fail-closed completion criteria, not pre-dispatch mediation.

Target apps are background-launched with `open -g`. The server samples frontmost state and consumes global focus notifications. If the target becomes frontmost, completion fails. Unrelated user focus changes are recorded but do not invalidate the operation.

## Usage, privacy, and audits

Each operation starts a separate Codex turn and consumes separate Codex plan/API usage. Results report token usage.

Audits include timestamps, operation/mode, canonical or hashed app identity, byte counts, outcome, methods, usage, and cleanup/focus results. They do **not** include task text, typed content, screenshots, app-state payloads, or model output. Policy-rejected requests are also audited once a secure state directory is available.

## Known limitations

- The integration targets fixed bundle paths inside the ChatGPT macOS app.
- App updates may change bundled paths, CLI flags, plugin schemas, or signing layout.
- First-party approvals may need completion in an official interactive OpenAI session.
- Browser-host Computer Use is not exposed; this project targets native macOS apps.
- In full-permissions mode, a target/method/focus/cleanup failure is detected after streamed events; mutations may already have occurred. Inspect and restore manually before retrying.
- Secure config-path failures may prevent audit creation because the server refuses to write through an untrusted path.

## Development

```bash
npm ci
npm run check
npm test
npm run build
```

Runtime dependencies are exact-pinned and the published graph is bound by `npm-shrinkwrap.json`.

See [`PROOF.md`](PROOF.md), [`SECURITY.md`](SECURITY.md), and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
