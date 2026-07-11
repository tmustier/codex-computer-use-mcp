# Proof and acceptance record

This document records the release-candidate evidence for the original implementation and its extraction into this standalone MCP server. It is not a claim that future ChatGPT app versions will remain compatible.

## Security boundary

The supported path is:

```text
MCP client → standalone wrapper → app-bundled Codex CLI → signed SkyComputerUseClient → official Computer Use service
```

Direct, unsigned access to the native service was rejected with sender-authentication failures. The implementation does not bypass that boundary. It verifies the fixed app-bundled Codex and Computer Use client binaries with `codesign --verify --strict` and checks OpenAI Team ID `2DC432GLL2` before each broker run.

The implementation also preserves:

- official OpenAI app approval and sensitive-action elicitation;
- macOS privacy controls;
- target-specific typed tool allowlists and exact output schema;
- target lease/alias validation;
- kernel-backed same-app exclusion;
- focus-event monitoring plus sampled frontmost verification;
- process-group timeout/cancellation cleanup;
- mode-`0600`, content-safe audits.

## Independent exact-head review

The final pre-install runtime was reviewed through the official app-bundled Codex CLI with:

- model: `gpt-5.6-sol`
- reasoning effort: `xhigh`
- verdict: `P0=0, P1=0, P2=0, P3=0`
- disposition: `NO BLOCKER / MERGE-READY`

An earlier independent review caught a real safe-mode bypass: category blocking covered display names but not canonical bundle identifiers and alias-resolved identities. The release candidate added canonical bundle-ID patterns, exact opaque-ID blocking, post-resolution policy revalidation, and regression tests for Messages, Slack, Passwords, System Settings, browsers, terminals, and editors. Full-permissions behavior remained explicit and unchanged.

## Core test evidence

The reviewed core completed:

- 33/33 tests passing outside a sandbox;
- strict TypeScript compilation;
- signed broker and typed Computer Use schema verification;
- crash-release and long-selector hashed lock tests;
- streamed final-event parsing and failed-status regressions;
- global focus watcher drain-before-final-query regression;
- config/audit no-follow, mode, and fsync checks.

The standalone extraction adds an MCP protocol test covering:

- stdio initialization and tool discovery;
- exact public tool names and required input schema;
- safe default status;
- fail-closed behavior when a client lacks form elicitation.

## Live acceptance

### Original installed extension

A fresh host session proved:

- `list`: 39 apps through exactly one signed `list_apps` call;
- stopped Calculator: background launch, `2 + 2 = 4`, `AC → 0`, required `click` capability satisfied, cleanup verified;
- external 100 ms focus sampling: 871 samples, zero Calculator-frontmost samples;
- post-run: zero worker directories, focus listeners, `lockf` holders, owner files, or harness processes.

Earlier live acceptance also exercised all ten official typed methods, different-app concurrency, same-app exclusion, and cancellation/process cleanup.

### Standalone MCP server

A real stdio MCP client called `background_computer_use` with `mode=list` against the extracted server in default safe mode:

- result: `ok`
- apps: 39
- successful official methods: `list_apps` only
- background preserved: `true`
- usage: reported by the nested Codex turn
- sanitized audit: written to a private temporary state directory

No Pi-specific runtime was involved in that call.

## Release gate

Before publishing a release:

1. Run `npm ci`, `npm run check`, `npm test`, and `npm run build`.
2. Verify the ChatGPT app and embedded client signatures on the target host.
3. Run a fresh stdio MCP `list` acceptance.
4. Run one stopped benign-app action with external focus sampling and cleanup verification.
5. Check for leaked workers, listeners, lock holders, owner records, and harness apps.
6. Independently review the exact release tree; do not publish with an unresolved P0/P1/P2 finding.

## Non-goals

This project does not provide a direct Sky/Computer Use protocol clone, browser-host integration, credential extraction, TCC automation, app injection, code-signing bypass, or automatic approval acceptance.
