# Codex Computer Use MCP

Expose OpenAI's official signed macOS Computer Use tools directly to Pi and MCP clients. The calling agent chooses each method and its arguments. This package runs no nested model and generates no action plan.

OpenAI does not produce or endorse this independent project. It relies on an experimental app-server API and installed ChatGPT components that may change.

## Requirements

- macOS with an unlocked user session
- Node.js 22 or newer
- the official ChatGPT macOS app, by default at `/Applications/ChatGPT.app`
- the Computer Use component installed by ChatGPT, by default under `~/.codex/computer-use/`
- Pi 0.80.7 or newer when using the Pi integration

macOS Screen Recording, Accessibility and TCC controls still apply.

## Pi

Install from npm:

```bash
pi install npm:codex-computer-use-mcp
```

The extension registers and activates one composable tool:

```text
computer_use({ code: string })
```

The code runs with `sky`, `emit`, `emitImage` and a persistent `store` object. `sky` exposes all ten official Computer Use methods, so known sequential actions can run without a model round-trip between each action:

```js
const state = await sky.get_app_state({ app: "TextEdit" });
emit(state.text);

await sky.click({ app: "TextEdit", element_index: "7" });
await sky.type_text({ app: "TextEdit", text: "hello" });
const next = await sky.get_app_state({ app: "TextEdit" });
emit(next.text);
```

Only values passed to `emit(...)` or `emitImage(...)` are returned to Pi. `list_apps` returns the official text inventory produced by the app-server transport; unlike native `@oai/sky`, that transport does not provide the structured app array. `get_app_state` may return an accessibility-tree diff after the first inspection; pass `disableDiff: true` to request a fresh full tree. Screenshot payloads remain in the parent process and cross the code-worker boundary only as small opaque handles. Code runs in a worker so an unbounded loop can be terminated without freezing Pi; time spent inside an official Computer Use call does not count toward the code execution slice. If a later action fails, Pi still receives earlier emitted observations and the attempted method sequence.

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

The adapter has one mode. Pi exposes the ten official methods through the single `computer_use` code tool; MCP exposes them as ten typed methods. Both are available without wrapper permission prompts. It adds no app allowlist, action gate, intent classifier, selector rewrite or focus policy. App-server uses Codex Full access. The adapter forwards any elicitation that the official host still emits.

Production calls require verified OpenAI-signed app-server and Computer Use binaries with Team ID `2DC432GLL2`. Before starting a new private broker, the adapter also verifies the Computer Use app bundle and opens it in the background through macOS Launch Services. This requests service startup in the logged-in user session instead of relying on the first client inside the broker's temporary `HOME`. Launch Services accepting the request is not a readiness probe; the official transport still handles initialization, and this does not claim to repair every app-server exit. Startup does not grant platform permissions, restart or terminate an existing shared service, or retry UI actions. If Launch Services fails, the call stops before dispatch with an instruction to open the app manually.

The adapter uses an isolated, credential-free app-server context. It rejects any model-turn activity. Calls after `get_app_state` reuse the signed session, preserving element identifiers and official app state.

Audit records contain bounded metadata. They exclude arguments, app content, screenshots, prompts and credentials. MCP and CLI state defaults to `~/.direct-computer-use`. Pi state defaults to `direct-computer-use` under the Pi agent directory. Set `CODEX_COMPUTER_USE_HOME` to override either default.

### Paths

By default the adapter uses the Codex app-server at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, falling back to `/Applications/ChatGPT.app/Contents/Resources/codex` on older ChatGPT builds. It uses the Computer Use app at `~/.codex/computer-use/Codex Computer Use.app`, falling back to the copy bundled in older ChatGPT builds.

When ChatGPT is installed elsewhere or moves these files, set either path in `config.json` in the state directory:

```json
{
  "codexPath": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "computerUseAppPath": "/Users/me/.codex/computer-use/Codex Computer Use.app"
}
```

The adapter reads this file when it starts each Computer Use session, so changes apply without restarting Pi or the MCP server. Configured binaries must pass the same OpenAI signature and Team ID checks. When a component is missing, the error lists the paths checked and the config file to edit. `/computer-use-status` and `codex-computer-use-mcp --status` show the config path and the current error.

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
