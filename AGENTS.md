# Repository guidance

This package is a thin transport adapter to OpenAI's official signed macOS Computer Use runtime, `cua_repl`, the JavaScript tool ChatGPT's own threads use. The calling agent writes each script. Codex, ChatGPT and macOS remain authoritative for tool behaviour, app access and platform permissions.

## Scope

- Follow ChatGPT's current Computer Use route. Expose the official `js` and `js_reset` tools with the descriptions and parameters ChatGPT's installed runtime gives its own model, and run ChatGPT's `cua_repl` server entry unchanged apart from what the isolated transport needs. By the owner's choice, `node_repl` starts directly, without ChatGPT's per-turn browser access grant.
- Do not add wrapper permission prompts, app or intent allowlists, action gates, risk classifiers, content inspection, alternate modes or model-driven planning.
- Do not reintroduce app rewriting, same-app locking or focus telemetry.
- Add adapter logic only for transport compatibility, zero-model-turn execution, retained official sessions, process lifecycle, packaging or a concrete user-visible bug.
- Keep signature and Team ID verification, isolated temporary state, model-turn rejection and process cleanup.

## Review

Review the exact production path and report material, reachable regressions. Do not block focused work on speculative hardening or malformed input that the official producer cannot emit.

A request to review does not authorize posting to GitHub. Show the user the exact proposed review, comment or issue text and get approval before posting it.

## Verification

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

Use benign applications for live acceptance.
