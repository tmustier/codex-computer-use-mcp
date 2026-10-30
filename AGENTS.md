# Repository guidance

This package is a thin transport adapter to OpenAI's official signed Computer Use tools: the macOS app-server MCP methods and the Windows `@oai/sky` helper methods. The calling agent selects each official method and its arguments. Codex and the operating system remain authoritative for tool behaviour, app access and platform permissions.

## Scope

- Preserve all official methods of each platform (ten on macOS, thirteen on Windows) and no-permissions behaviour. MCP exposes them as typed tools. Pi registers the same methods as `codemode`-exposure tools, so agents compose them through Pi's built-in `codemode` tool.
- Do not add wrapper permission prompts, app or intent allowlists, action gates, risk classifiers, content inspection, alternate modes or model-driven planning.
- Do not reintroduce app rewriting, same-app locking or focus telemetry.
- Add adapter logic only for transport compatibility, zero-model-turn execution, retained official sessions, process lifecycle, packaging or a concrete user-visible bug.
- Keep signature verification (codesign Team ID on macOS, Authenticode signer on Windows), isolated temporary state, model-turn rejection and process cleanup.
- Do not add a separate code executor. Pi's `codemode` runs scripts; do not change which Pi tools are active.
- Preserve compatible additional tool arguments and pass app selectors through unchanged.

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
