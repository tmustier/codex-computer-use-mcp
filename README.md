# Codex Computer Use MCP

A local MCP server that lets compatible agents inspect and operate native macOS apps **in the background** through the official, signed Computer Use broker bundled with the OpenAI ChatGPT app.

It exposes the full typed Computer Use surface while preserving the controls that matter:

- official OpenAI code-signing checks;
- first-party app approvals and sensitive-action prompts;
- macOS Screen Recording and Accessibility permissions;
- safe-by-default policy and interactive MCP elicitation;
- per-app kernel locks;
- foreground/focus telemetry with fail-closed background guarantees;
- exact tool schemas, call budgets, timeout and process-group cleanup;
- sanitized, mode-`0600` metadata audits.

> **Independent project.** This is not an OpenAI product and is not endorsed by OpenAI. It depends on implementation details in the macOS ChatGPT app and may need updates when that app changes.

## Requirements

- macOS
- Node.js 22 or newer
- the official ChatGPT macOS app at `/Applications/ChatGPT.app`
- a Codex account/session available to the app-bundled Codex CLI
- any required first-party OpenAI app approvals and macOS privacy permissions, completed in their official UI

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

Input modes:

| Mode | Purpose |
|---|---|
| `list` | List apps visible to official Computer Use |
| `inspect` | Read the state of one app |
| `act` | Perform a concrete task in one app |
| `dictionary_lookup` | Narrow local Apple Dictionary lookup |

Optional fields include `cleanup`, `cleanup_instructions`, and `required_capabilities`. The latter can require genuine use of one or more official methods:

`list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `set_value`, `select_text`, `scroll`, `drag`, `press_key`, `type_text`.

### `background_computer_use_status`

Returns the permission mode, state and audit locations, model, approval boundary, and supported methods.

## Permission modes

### Safe mode (default)

Safe mode blocks high-risk apps and intents. App inspection/actions require a user confirmation through MCP **form elicitation**, except the constrained Dictionary profile. A client without form-elicitation support fails closed for those operations.

List mode and constrained Dictionary lookup do not require wrapper confirmation. Official OpenAI and macOS prompts remain authoritative for every mode.

### Full-permissions mode

This intentionally removes the wrapper's app, intent, and per-operation confirmation gates. It does **not** bypass official OpenAI approvals, sensitive-action prompts, macOS privacy controls, signing checks, focus monitoring, locks, call budgets, timeout cleanup, or audit logging.

Enable it only with an explicit acknowledgement:

```bash
codex-computer-use-mcp --configure full-permissions --acknowledge-full-permissions
```

Return to safe mode:

```bash
codex-computer-use-mcp --configure safe
```

State defaults to `~/.codex-computer-use-mcp`. Override it with `CODEX_COMPUTER_USE_HOME`. Configuration changes are written mode `0600` and audited; an audit failure rolls the change back.

## MCP client configuration

### Pi

For Pi's native confirmation UI, install the included Pi package adapter:

```bash
pi install npm:codex-computer-use-mcp@0.1.0
```

This registers `background_computer_use`, `/background-computer-use-status`, and `/background-computer-use-mode`. Pi supplies the confirmation dialog in safe mode.

Alternatively, use the stdio server through Pi's MCP gateway. Add it to `~/.pi/agent/mcp.json`. Keep `directTools: false` so its capability remains intentional rather than an always-on direct tool:

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

See [`integrations/pi/`](integrations/pi/) for both adapter options. Do not install the native Pi adapter and MCP registration simultaneously under the same tool name.

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

The nested Codex turn is pinned to `gpt-5.6-sol` at `xhigh` reasoning, receives a mode-specific allowlist, runs with shell/web/remote plugins disabled, and emits a constrained result schema. Every successful event is checked against the target lease and requested capability set.

The target app is background-launched with `open -g`; the server samples frontmost state and consumes global focus notifications. If the target becomes frontmost, the operation fails closed. Unrelated user focus changes are recorded but do not invalidate the operation.

## Usage, privacy, and audits

Each operation starts a separate Codex turn and consumes separate Codex plan/API usage. The tool result reports token usage.

Audit records include timestamps, operation/mode, canonical or hashed app identity, byte counts, outcome, methods used, usage, and cleanup/focus results. They do **not** include task text, typed content, screenshots, app-state payloads, or model output.

## Known limitations

- The integration currently targets fixed bundle paths inside the ChatGPT macOS app.
- App updates may change bundled paths, CLI flags, plugin schemas, or signing layout.
- First-party approvals may need to be completed in an official interactive OpenAI session before a background retry.
- Browser-host Computer Use is not exposed; this project targets native macOS apps.
- A foreground-preservation failure aborts the operation, but a mutating call may already have changed app state; inspect and restore manually before retrying.

## Development

```bash
npm ci
npm run check
npm test
npm run build
```

The test suite covers policy, canonical identity blocking, signed broker/schema presence, streamed event validation, argument drift, call budgets, cancellation/timeouts, locks, focus monitoring, secure config/audit handling, native harnesses, and the stdio MCP handshake.

See [`PROOF.md`](PROOF.md) for acceptance evidence and [`SECURITY.md`](SECURITY.md) for reporting guidance.

## License

MIT
