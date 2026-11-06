# Codex Computer Use MCP

Give Pi and MCP clients OpenAI's official signed Computer Use runtime, `cua_repl`: the same JavaScript tool that ChatGPT's own threads use to operate apps and browsers. It runs on macOS, and experimentally on Windows (see [Windows](#windows-experimental)). The calling agent writes each script. This package runs no nested model and generates no action plan.

OpenAI does not produce or endorse this independent project. It relies on an experimental app-server API and installed ChatGPT components that may change.

## Requirements

- macOS with an unlocked user session, or Windows (experimental)
- Node.js 22 or newer
- the official ChatGPT macOS app with its unified Computer Use plugin (tested with ChatGPT for Work 26.1029.61003), by default at `/Applications/ChatGPT.app`
- ChatGPT opened at least once since its last update, so it has written its Computer Use runtime settings. ChatGPT writes them only when OpenAI has turned on its unified Computer Use runtime for the account; without them, the adapter falls back to the older typed tools (see [Accounts without the unified runtime](#accounts-without-the-unified-runtime-deprecated))
- the Computer Use component installed by ChatGPT, by default under `~/.codex/computer-use/`
- Pi 0.99.0 or newer when using the Pi integration

macOS Screen Recording, Accessibility and TCC controls still apply.

## Pi

Install from npm:

```bash
pi install npm:codex-computer-use-mcp
```

After `pi update`, run `/reload` to load the new version.

The extension registers two ordinary Pi tools:

- `cua_repl` is the official `js` tool. It runs JavaScript in a persistent official runtime with a `cua` object for apps and browser tabs.
- `cua_repl_reset` is the official `js_reset` tool. It discards the runtime's JavaScript bindings.

Their descriptions and parameters are the ones ChatGPT's installed runtime gives its own model, read from ChatGPT when the extension loads. They explain the API, so an agent can start with:

```js
let app = await cua.getApp("TextEdit");
```

The result includes the app's accessibility tree and the API documentation. Later calls reuse the binding:

```js
await app.click(7);
await app.typeText("hello");
await app.getAXState();
```

Bindings such as `app` last across calls and agent turns until `cua_repl_reset`, a transport failure or the end of the Pi session. When the agent settles, the extension sends the official `turn_ended` notification, as ChatGPT does when its turn stops, so the service can clear that turn's software cursor.

The runtime also drives browsers ChatGPT can reach, such as Chrome through ChatGPT's Chrome extension. `cua.listTabs()` lists your tabs, and `cua.createBrowserTab("chrome", url, { sessionName })` opens one for the agent, which can read it, act in it and close it. Inside ChatGPT each turn needs ChatGPT's browser access grant. This adapter starts the runtime without ChatGPT's grant host, so browser use needs no grant.

A failed call returns the official error text as an error result, followed by a recovery step when the adapter recognises the cause (see [Failures](#failures)). Pi limits returned text to 50KB or 2,000 lines. When text exceeds that limit, the complete text is written to a mode-0600 file in a private directory under `/tmp`. Images are returned directly and are never spilled to disk.

Use `/computer-use-status` to inspect the installed components and transport status.

### Upgrading from 0.6

Version 0.7.0 replaces the ten `computer_use_<method>` codemode tools with `cua_repl` wherever ChatGPT has its unified runtime. Scripts that called `tools.computer_use_get_app_state({ app })` and similar tools now call the `cua` API inside `cua_repl`: `cua.getApp(app)`, `app.getAXState()`, `app.click(index or [x, y])`, `app.typeText(text)`, `app.pressKey(key)` and so on. The official tool description lists every method.

### Accounts without the unified runtime (deprecated)

OpenAI turns on ChatGPT's unified Computer Use runtime per account. Where it is off, ChatGPT itself still uses the ten older typed tools, and so does this adapter: when Pi loads the extension or the MCP server starts, and ChatGPT has not written its `cua_repl` settings, the adapter registers the 0.6 tools instead (`computer_use_<method>` codemode tools in Pi, `<method>` tools over MCP). Status reports `"route": "legacy"` and why. Browser control needs the unified runtime.

On Windows the fallback is Ross Zhu's port of the 0.6 route: the official `@oai/sky` Windows client and its thirteen window-based tools (`list_apps`, `list_windows`, `get_window_state`, `launch_app` and so on). Its `computerUseAppPath` setting names the `@oai/sky` package.

This fallback is deprecated and is likely to be removed once the unified runtime reaches every account. If OpenAI turns it on later, `/reload` in Pi or restart the MCP server to switch to `cua_repl`.

To run a source checkout:

```bash
npm ci
npm run build
pi -ne -e /absolute/path/to/codex-computer-use-mcp/integrations/pi/index.ts
```

## MCP

Running the package binary starts a stdio MCP server with the official `js` and `js_reset` tools and `computer_use_status`:

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

MCP has no turn boundary, so the server sends `turn_ended` after a minute without calls. The runtime and its bindings stay until the client disconnects.

## Behaviour

Each session starts ChatGPT's signed Codex app-server with an isolated, credential-free home and asks it to run ChatGPT's own `cua_repl` server: OpenAI's signed `node_repl` with the settings ChatGPT wrote to `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<ChatGPT version>/.mcp.json`. The adapter passes that server entry through unchanged, with three exceptions: a private working directory; the account's real `HOME`, which the runtime needs to find the shared Computer Use service; and starting `node_repl` directly rather than through ChatGPT's shell wrapper, so the runtime does not ask ChatGPT for a browser access grant. The app-server stays isolated. The Computer Use service accepts the runtime only when a signed OpenAI parent starts it, so the app-server cannot be skipped.

Production calls require verified OpenAI-signed binaries with Team ID `2DC432GLL2`: the app-server, `node_repl`, the Node.js binary it names, and the Computer Use service. The adapter rejects any model-turn activity. It adds no permission prompts, app allowlist, action gate or content inspection. App-server uses Codex Full access. The adapter forwards any elicitation that the official host emits.

Closing a session ends its turn, then terminates its private processes. Cancellation and tool timeouts briefly wait for an outstanding native reply before ending the turn, so a late reply cannot recreate the cursor after cleanup. A stalled request, failed notification or lost transport can prevent native cleanup. The call still returns its result, because the action already ran, and private process teardown still runs. `brokerCleanupVerified` describes private process cleanup, not visual confirmation that a cursor disappeared.

Audit records contain bounded metadata. They exclude code, arguments, app content, screenshots, prompts and credentials. MCP and CLI state defaults to `~/.direct-computer-use`. Pi state defaults to `direct-computer-use` under the Pi agent directory. Set `CODEX_COMPUTER_USE_HOME` to override either default.

### Paths

By default the adapter checks `/Applications/ChatGPT.app`, then `~/Applications/ChatGPT.app` in the OS account's home directory, then any other app Spotlight finds with ChatGPT's bundle ID `com.openai.codex` (for example an install still named `Codex.app` because the classic ChatGPT app occupies `ChatGPT.app`). In each bundle it looks for `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, then `Contents/Resources/codex` on older ChatGPT builds. It reads ChatGPT's `cua_repl` settings for that bundle's version from the plugin cache above. It does not use an arbitrary `codex` on `PATH` or the ambient `CODEX_CLI_PATH`.

When ChatGPT is installed elsewhere, or keeps its settings elsewhere, set either path in `config.json` in the state directory:

```json
{
  "codexPath": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "cuaReplConfigPath": "/Users/me/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1029.61003/.mcp.json"
}
```

The adapter reads this file when it starts each Computer Use session, so changes apply without restarting Pi or the MCP server. Tool descriptions are read when Pi loads the extension or the MCP server starts. Configured binaries must pass the same OpenAI signature and Team ID checks. Explicit overrides take precedence: a missing or invalid configured path never silently falls back to another installation. Version 0.6's `computerUseAppPath` setting is ignored; the runtime settings name the Computer Use app.

If a component is missing, install or update the [official ChatGPT macOS app](https://chatgpt.com/download), open it, and install its Computer Use component. Installing this npm package alone does not install those signed components. The error lists the paths checked and the exact config file to edit. For Pi this is normally `~/.pi/agent/direct-computer-use/config.json`; for standalone MCP/CLI it is `~/.direct-computer-use/config.json`. `CODEX_COMPUTER_USE_HOME` overrides the state directory. `/computer-use-status` and `codex-computer-use-mcp --status` show the effective config path and the current error.

### Windows (experimental)

ChatGPT for Windows runs the same `cua_repl` runtime, and the adapter follows it the same way, with these differences:

- Codex is the newest `%LOCALAPPDATA%\OpenAI\Codex\bin\<version>\codex.exe`, and the settings are the newest `%USERPROFILE%\.codex\plugins\cache\openai-bundled\unified-computer-use\<version>\.mcp.json`. `codexPath` and `cuaReplConfigPath` override them as on macOS.
- ChatGPT starts the runtime through Node and `@oai/cua-repl`'s launcher rather than a shell wrapper. The adapter drops the launcher's `--import` of ChatGPT's browser access bootstrap, which is the Windows form of the same grant check.
- Binaries must carry a valid Authenticode signature from "OpenAI OpCo, LLC": the app-server, `node.exe`, `node_repl.exe` and the Computer Use helper `codex-computer-use.exe`.
- The tool descriptions come from the runtime's own `create_launch_environment`, because ChatGPT for Windows builds them at launch instead of writing them into the settings.
- Cleanup ends the private process tree with `taskkill /T`.

Windows support has not been run against a real ChatGPT for Windows install yet. CI installs, builds and tests the package on Windows. The paths, the signature subject and the launch form come from ChatGPT's own code and from Ross Zhu's tested 0.6 port, so a live check may still turn up differences. Please report what you find.

### Operating ChatGPT itself

By default the official service refuses to operate the ChatGPT app, with `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` As of ChatGPT for Work 26.1029.61003 with Computer Use 1001730, a global macOS preference lifts this:

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

It applies to every Computer Use client on the Mac, including ChatGPT's own threads. The name suggests it also allows the service's other forbidden apps; only ChatGPT has been tested. To undo it, run `defaults delete -g ComputerUseAllowForbiddenTargets`.

Select ChatGPT by full path, such as `/Applications/ChatGPT.app`, when another copy of the app shares its `com.openai.codex` bundle identifier. ChatGPT exposes its full interface to the accessibility tree, including the conversation list and composer, whether or not it is in front. In testing, the first reads returned only the window frame and menu bar; if that happens, read the state again.

### Failures

Errors name the cause and the next step, so an agent can recover or tell the user:

| Cause | What the error says |
| --- | --- |
| The Computer Use service is stuck | Official `Sky Computer Use native pipe startup failed`, or a tool-call timeout, followed by `pkill -f MacOS/SkyComputerUseService`. The runtime relaunches the service on the next call. If it fails again, relaunch ChatGPT. |
| ChatGPT stopped providing its unified runtime after the tools loaded, for example after an update | `ChatGPT <version> has not prepared its Computer Use runtime`: open ChatGPT, wait for it to start, and retry. If the runtime is still missing, `/reload` in Pi or restart the MCP server to switch to the older typed tools. |
| ChatGPT is updating, or the Mac is busy | `codesign did not finish within 30 seconds`: wait and retry. |
| A ChatGPT bundle is damaged or mid-update | `Signature verification failed for …`, with the reason from `codesign`. |
| ChatGPT and this package no longer match | The app-server's own error, the last lines it printed before exiting, or an unexpected runtime settings shape, followed by both versions and a step to update ChatGPT and this package and restart the client. |
| ChatGPT or its Computer Use component is not installed | The paths checked and how to install it. |

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
