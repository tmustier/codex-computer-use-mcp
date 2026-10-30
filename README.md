# Codex Computer Use MCP

Expose OpenAI's official signed Computer Use tools for macOS and Windows directly to Pi and MCP clients. The calling agent chooses each method and its arguments. This package runs no nested model and generates no action plan.

OpenAI does not produce or endorse this independent project. It relies on an experimental app-server API and installed ChatGPT components that may change.

## Requirements

- Node.js 22 or newer
- Pi 0.99.0 or newer when using the Pi integration

On macOS:

- an unlocked user session
- the official ChatGPT macOS app, by default at `/Applications/ChatGPT.app`
- the Computer Use component installed by ChatGPT, by default under `~/.codex/computer-use/`

macOS Screen Recording, Accessibility and TCC controls still apply.

On Windows:

- an interactive desktop session
- the official ChatGPT (Codex) Windows app with Computer Use enabled, which installs the `@oai/sky` runtime under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\`

Windows Computer Use asks for approval the first time an app is used. The adapter forwards that official request to Pi or the MCP client; it adds no prompts of its own.

## Pi

Install from npm:

```bash
pi install npm:codex-computer-use-mcp
```

The extension registers the official Computer Use methods of the host platform as Pi tools named `computer_use_<method>`. They use Pi's `codemode` exposure, so agents call and compose them from Pi's built-in `codemode` tool together with other Pi and MCP tools.

On macOS these are the ten app-server methods, such as `computer_use_get_app_state` and `computer_use_click`:

```js
const state = await tools.computer_use_get_app_state({ app: "TextEdit" });
text(state.text);
image(state.screenshot);

await tools.computer_use_click({ app: "TextEdit", element_index: "7" });
await tools.computer_use_type_text({ app: "TextEdit", text: "hello" });
const next = await tools.computer_use_get_app_state({ app: "TextEdit" });
text(next.text);
```

The extension does not change which tools are active. Turn on `codemode` with `"defaultTools": ["+codemode"]` in `settings.json` or with `pi --tools +codemode`; Pi also turns it on when an MCP server uses `codemode` exposure. When neither `codemode` nor a Computer Use tool is active, the extension shows one notice at the first prompt.

`computer_use_get_app_state` resolves to `{ app, text, screenshot }`, where `screenshot` is an image block for `image()` or `null`. It may return an accessibility-tree diff after the first inspection; pass `disableDiff: true` to request a fresh full tree. `computer_use_list_apps` resolves to the official text inventory produced by the app-server transport; unlike native `@oai/sky`, that transport does not provide the structured app array. Other methods resolve to their official text output. A failed call rejects with the official error text. Calls run one at a time, and calls after `get_app_state` reuse the signed session until the agent settles. The namespace instructions, available from `describeNamespace("computer_use")`, summarise this workflow.

On Windows the official surface is the `@oai/sky` window API, so the tools are `list_apps`, `list_windows`, `get_window`, `launch_app`, `get_window_state`, `click`, `press_key`, `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action` and `activate_window`. Actions target a window object taken from `list_apps` or `list_windows`:

```js
const { apps } = await tools.computer_use_list_apps({});
const window = apps.find((app) => app.displayName === "Notepad")?.windows[0];
const state = await tools.computer_use_get_window_state({ window, include_text: true });
text(state.accessibility?.tree ?? "");
for (const shot of state.screenshots) if (shot.image) image(shot.image);

await tools.computer_use_click({ window, element_index: 7 });
await tools.computer_use_type_text({ window, text: "hello" });
```

`computer_use_list_apps` resolves to `{ apps }`, `computer_use_list_windows` to `{ windows }` and `computer_use_get_window_state` to `{ window, accessibility, screenshots }`, the official JavaScript results; each screenshot carries an `image` block for `image()`. Other methods resolve to `ok`. The first use of an app raises the official approval request, which Pi shows as a selection between a session-only and a permanent approval. Any call opens the retained helper session, which is closed when the agent settles.

Use `/computer-use-status` to inspect the installed component and transport status.

To run a source checkout:

```bash
npm ci
npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

## MCP

Running the package binary starts a stdio MCP server with the same platform methods and `computer_use_status`:

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

The adapter has one mode. Pi and MCP both expose the official methods of the host platform as typed tools; Pi gives them `codemode` exposure. Both are available without wrapper permission prompts. It adds no app allowlist, action gate, intent classifier, selector rewrite or focus policy. App-server uses Codex Full access. The adapter forwards any elicitation that the official host still emits.

On macOS, production calls require verified OpenAI-signed app-server and Computer Use binaries with Team ID `2DC432GLL2`. The adapter uses an isolated, credential-free app-server context. It rejects any model-turn activity. Calls after `get_app_state` reuse the signed session, preserving element identifiers and official app state.

On Windows there is no app-server path: the Codex app drives Computer Use through the `@oai/sky` JavaScript client, which runs the signed `codex-computer-use.exe` helper over stdio. The adapter loads that official client from the installed runtime after verifying the helper's Authenticode signature (status `Valid`, signer `OpenAI OpCo, LLC`) and its canonical location. The official client receives app-approval requests from the helper and expects a `node_repl` host to answer them; the adapter provides only that host surface and forwards each request as an elicitation. The host owns approval memory, as in Codex: a session approval is remembered for the lifetime of the Pi or MCP server process, and an "always" approval is written to `windows-approvals.json` in the state directory (mode 0600). Both map the call's target — the window's `app` field or `launch_app`'s `app` — to the helper's own app id, which is what later requests are marked with; delete the file to forget permanent approvals. Any call opens the retained helper session; closing it ends the helper process.

While a helper turn is open, Computer Use shows its "ChatGPT is using your computer" overlay and holds the mouse and keyboard; element indexes from `get_window_state` are valid only within that turn. Codex ends the turn with the model's turn. Pi closes the session when the agent settles, and the adapter also ends a turn after `CODEX_COMPUTER_USE_TURN_IDLE_MS` (default 15000) without calls, which is how MCP clients release the desktop between actions. A call in a new turn must inspect the window again before acting on an element; the helper says so. Pressing Esc cancels the current turn at any time.

Closing a retained session sends a matching native `turn-ended` notification through the signed app-server before terminating its private processes. This lets the shared Computer Use service remove that session's software cursor without terminating the service. Cancellation and tool timeouts briefly wait for an outstanding native reply before notifying, so a late reply cannot recreate the cursor after cleanup. A stalled request, failed notification, or lost transport can prevent native cleanup. The call still returns its result, because the action already ran, and private process teardown still runs. `brokerCleanupVerified` describes private process cleanup, not visual confirmation that a cursor disappeared.

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

On Windows the adapter uses the newest `@oai/sky` package under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<runtime>\bin\node_modules\@oai\sky`. Set `computerUseAppPath` to that package directory to use another copy. The helper matching the Node architecture is preferred; when only the other one is installed (for example x64 Node on Windows on Arm, where the Codex app installs only `codex-computer-use-arm64.exe`), that signed helper is used. The helper asks `codex app-server` for its ChatGPT auth token, so the adapter passes it `CODEX_CLI_PATH`: `codexPath` when set, otherwise the newest signed `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin\<version>\`. A `CODEX_CLI_PATH` already in the environment is left to the helper.

The adapter reads this file when it starts each Computer Use session, so changes apply without restarting Pi or the MCP server. Configured binaries must pass the same OpenAI signature checks. When a component is missing, the error lists the paths checked and the config file to edit. `/computer-use-status` and `codex-computer-use-mcp --status` show the platform, the config path and the current error.

Pi limits returned text to 50KB or 2,000 lines. When text exceeds that limit, the complete text is written to a mode-0600 file in a private directory under `/tmp`. Images are returned directly and are never spilled to disk.

## Development

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

`npm test` includes one live call through the signed component of the host platform (`list_apps`); the other platform's transport tests are skipped.

## License

MIT
