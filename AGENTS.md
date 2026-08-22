# Repository guidance

This package is a thin transport adapter to OpenAI's official signed macOS Computer Use tools. The calling agent selects each official method and its arguments. Codex and macOS remain authoritative for tool behaviour, app access and platform permissions.

## Scope

- Preserve all ten official methods and no-permissions behaviour. MCP exposes them as typed tools; Pi may expose the same methods through one composable `computer_use({ code })` tool.
- Do not add wrapper permission prompts, app or intent allowlists, action gates, risk classifiers, content inspection, alternate modes or model-driven planning.
- Do not reintroduce app rewriting, same-app locking or focus telemetry.
- Add adapter logic only for transport compatibility, zero-model-turn execution, retained official sessions, process lifecycle, packaging or a concrete user-visible bug.
- Keep signature and Team ID verification, isolated temporary state, model-turn rejection and process cleanup.
- Run model-authored Pi code outside Pi's main thread with real cancellation, and preserve emitted observations plus completed-call history when a batch stops partway through.
- Preserve compatible additional tool arguments and pass app selectors through unchanged.

## Review

Review the exact production path and report material, reachable regressions. Do not block focused work on speculative hardening or malformed input that the official producer cannot emit.

A request to review does not authorize posting to GitHub. Show Thomas the exact proposed review, comment or issue text and get approval before posting it.

## Verification

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

Use benign applications for live acceptance.
