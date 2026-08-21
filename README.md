# Codex Computer Use MCP

Expose OpenAI's official signed macOS Computer Use tools directly to Pi and MCP clients. The calling agent chooses each method and its arguments. This package runs no nested model and generates no action plan.

OpenAI does not produce or endorse this independent project. It relies on an experimental app-server API and installed ChatGPT components that may change.

## Requirements

- macOS with an unlocked user session
- Node.js 22 or newer
- the official ChatGPT macOS app at `/Applications/ChatGPT.app`
- the Computer Use component installed by ChatGPT under `~/.codex/computer-use/`
- Pi 0.80.7 or newer when using the Pi integration

macOS Screen Recording, Accessibility and TCC controls still apply.

## Pi

Install from npm:

```bash
pi install npm:codex-computer-use-mcp
```

The extension registers and activates these tools:

```text
computer_use_list_apps
computer_use_get_app_state
computer_use_click
computer_use_perform_secondary_action
computer_use_set_value
computer_use_select_text
computer_use_scroll
computer_use_drag
computer_use_press_key
computer_use_type_text
```

Use `/computer-use-status` to inspect the installed component and transport status.

To run a source checkout:

```bash
npm ci
npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

## MCP

Running the package binary starts a stdio MCP server with the same ten methods and `computer_use_status`:

```bash
npx codex-computer-use-mcp
```

Example Pi MCP configuration:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["codex-computer-use-mcp"],
      "lifecycle": "lazy",
      "requestTimeoutMs": 180000,
      "directTools": false
    }
  }
}
```

## Behaviour

The adapter has one mode. All ten official methods are available without wrapper permission prompts. It adds no app allowlist, action gate, intent classifier, selector rewrite or focus policy. App-server uses Codex Full access. The adapter forwards any elicitation that the official host still emits.

Production calls require verified OpenAI-signed app-server and Computer Use binaries with Team ID `2DC432GLL2`. The adapter uses an isolated, credential-free app-server context. It rejects any model-turn activity. Calls after `get_app_state` reuse the signed session, preserving element identifiers and official app state.

Audit records contain bounded metadata. They exclude arguments, app content, screenshots, prompts and credentials. MCP and CLI state defaults to `~/.direct-computer-use`. Pi state defaults to `direct-computer-use` under the Pi agent directory. Set `CODEX_COMPUTER_USE_HOME` to override either default.

Pi limits returned text to 50KB or 2,000 lines. When text exceeds that limit, the complete text is written to a mode-0600 file in a private directory under `/tmp`. Images are returned directly and are never spilled to disk.

## Development

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

## License

MIT
