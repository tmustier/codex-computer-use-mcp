# Codex Computer Use MCP

Expose OpenAI's official signed macOS Computer Use tools directly to Pi and MCP clients. The calling agent chooses each method and its arguments. This package runs no nested model and generates no action plan.

OpenAI does not produce or endorse this independent project. It relies on an experimental app-server API and installed ChatGPT components that may change.

## Requirements

- macOS with an unlocked user session
- Node.js 22 or newer
- the official ChatGPT macOS app, by default at `/Applications/ChatGPT.app`
- the Computer Use component installed by ChatGPT, by default under `~/.codex/computer-use/`
- Pi 0.99.0 or newer when using the Pi integration

macOS Screen Recording, Accessibility and TCC controls still apply.

## Pi

Install from npm:

```bash
pi install npm:codex-computer-use-mcp
```

After `pi update`, run `/reload` to load the new version. Updating to 0.6.5 from an earlier version also works with `/reload`. Earlier versions loaded their code from `dist/`, which Pi keeps cached until it restarts.

The extension registers the ten official Computer Use methods as Pi tools named `computer_use_<method>`, such as `computer_use_get_app_state` and `computer_use_click`. They use Pi's `codemode` exposure, so agents call and compose them from Pi's built-in `codemode` tool together with other Pi and MCP tools:

```js
const state = await tools.computer_use_get_app_state({ app: "TextEdit" });
text(state.text);
image(state.screenshot);

await tools.computer_use_click({ app: "TextEdit", element_index: "7" });
await tools.computer_use_type_text({ app: "TextEdit", text: "hello" });
const next = await tools.computer_use_get_app_state({ app: "TextEdit" });
text(next.text);
```

`element_index` accepts a string or a safe integer for all five methods that use it. Integers are converted to strings before reaching the official tools; string identifiers are preserved exactly. Use indices from the latest app state, because actions can invalidate earlier indices.

The extension does not change which tools are active. Turn on `codemode` with `"defaultTools": ["+codemode"]` in `settings.json` or with `pi --tools +codemode`; Pi also turns it on when an MCP server uses `codemode` exposure. When neither `codemode` nor a Computer Use tool is active, the extension shows one notice at the first prompt.

`computer_use_get_app_state` resolves to `{ app, text, screenshot }`, where `screenshot` is an image block for `image()` or `null`. It may return an accessibility-tree diff after the first inspection; pass `disableDiff: true` to request a fresh full tree. `computer_use_list_apps` resolves to the official text inventory produced by the app-server transport; unlike native `@oai/sky`, that transport does not provide the structured app array. Other methods resolve to their official text output. A failed call rejects with the official error text, followed by a recovery step when the adapter recognises the cause (see [Failures](#failures)). Calls run one at a time, and calls after `get_app_state` reuse the signed session until the agent settles. The namespace instructions, available from `describeNamespace("computer_use")`, summarise this workflow.

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

The adapter has one mode. Pi and MCP both expose the ten official methods as typed tools; Pi gives them `codemode` exposure. Both are available without wrapper permission prompts. It adds no app allowlist, action gate, intent classifier, selector rewrite or focus policy. App-server uses Codex Full access. The adapter forwards any elicitation that the official host still emits.

Production calls require verified OpenAI-signed app-server and Computer Use binaries with Team ID `2DC432GLL2`. The adapter uses an isolated, credential-free app-server context. It rejects any model-turn activity. Calls after `get_app_state` reuse the signed session, preserving element identifiers and official app state.

Closing a retained session sends a matching native `turn-ended` notification through the signed app-server before terminating its private processes. This lets the shared Computer Use service remove that session's software cursor without terminating the service. Cancellation and tool timeouts briefly wait for an outstanding native reply before notifying, so a late reply cannot recreate the cursor after cleanup. A stalled request, failed notification, or lost transport can prevent native cleanup. The call still returns its result, because the action already ran, and private process teardown still runs. `brokerCleanupVerified` describes private process cleanup, not visual confirmation that a cursor disappeared.

Audit records contain bounded metadata. They exclude arguments, app content, screenshots, prompts and credentials. MCP and CLI state defaults to `~/.direct-computer-use`. Pi state defaults to `direct-computer-use` under the Pi agent directory. Set `CODEX_COMPUTER_USE_HOME` to override either default.

### Paths

By default the adapter checks `/Applications/ChatGPT.app`, then `~/Applications/ChatGPT.app` in the OS account's home directory, then any other app Spotlight finds with ChatGPT's bundle ID `com.openai.codex` (for example an install still named `Codex.app` because the classic ChatGPT app occupies `ChatGPT.app`). In each bundle it looks for `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, then `Contents/Resources/codex` on older ChatGPT builds. It uses the Computer Use app at `~/.codex/computer-use/Codex Computer Use.app`, falling back to the copy bundled in any of those ChatGPT installations on older builds. It does not use an arbitrary `codex` on `PATH` or the ambient `CODEX_CLI_PATH`.

When ChatGPT is installed elsewhere or moves these files, set either path in `config.json` in the state directory:

```json
{
  "codexPath": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "computerUseAppPath": "/Users/me/.codex/computer-use/Codex Computer Use.app"
}
```

The adapter reads this file when it starts each Computer Use session, so changes apply without restarting Pi or the MCP server. Configured binaries must pass the same OpenAI signature and Team ID checks. Explicit overrides take precedence: a missing or invalid configured binary never silently falls back to another installation.

If a component is missing, install or update the [official ChatGPT macOS app](https://chatgpt.com/download), open it, and install its Computer Use component. Installing this npm package alone does not install those signed components. The error lists every path checked and the exact config file to edit. Correct `codexPath` / `computerUseAppPath` there, or remove a stale override to restore automatic discovery. For Pi this is normally `~/.pi/agent/direct-computer-use/config.json`; for standalone MCP/CLI it is `~/.direct-computer-use/config.json`. `CODEX_COMPUTER_USE_HOME` overrides the state directory. `/computer-use-status` and `codex-computer-use-mcp --status` show the effective config path and the current error.

### Operating ChatGPT itself

By default the official service refuses to operate the ChatGPT app, with `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` As of ChatGPT for Work 26.1029.61003 with Computer Use 1001730, a global macOS preference lifts this:

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

It applies to every Computer Use client on the Mac, including ChatGPT's own threads. The name suggests it also allows the service's other forbidden apps; only ChatGPT has been tested. To undo it, run `defaults delete -g ComputerUseAllowForbiddenTargets`.

Select ChatGPT by full path, such as `/Applications/ChatGPT.app`, when another copy of the app shares its `com.openai.codex` bundle identifier. ChatGPT exposes its full interface to the accessibility tree, including the conversation list and composer, whether or not it is in front. In testing, the first reads returned only the window frame and menu bar; if that happens, read the state again.

Pi limits returned text to 50KB or 2,000 lines. When text exceeds that limit, the complete text is written to a mode-0600 file in a private directory under `/tmp`. Images are returned directly and are never spilled to disk.

### Failures

ChatGPT does not need to be running. The official client starts the Computer Use service when a call needs it.

Errors name the cause and the next step, so an agent can recover or tell the user:

| Cause | What the error says |
| --- | --- |
| The Computer Use service is stuck | Official `bootstrapTimedOut`, or a tool-call timeout, followed by `pkill -f MacOS/SkyComputerUseService`. The service relaunches on the next call. If it fails again, relaunch ChatGPT. |
| ChatGPT is updating, or the Mac is busy | `codesign did not finish within 30 seconds`: wait and retry. |
| A ChatGPT bundle is damaged or mid-update | `Signature verification failed for …`, with the reason from `codesign`. |
| ChatGPT and this package no longer match | The app-server's own error, or the last lines it printed before exiting, followed by both versions and a step to update ChatGPT and this package and restart the client. The same step follows a missing file inside an installed ChatGPT. |
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
