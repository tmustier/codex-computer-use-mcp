# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could weaken signing, schema verification, permission-mode dispatch, first-party approval handling, app identity, locking, focus telemetry, cleanup, or audit integrity.

Use GitHub private vulnerability reporting. Include the affected commit/version, the smallest non-sensitive reproduction, expected versus observed behavior, and whether an official action completed before failure.

Never include credentials, tokens, customer/private content, sensitive screenshots, raw app-state payloads, elicitation contents, or private audit files.

## Architecture boundary

Raw Pi/Node invocation of the signed Computer Use MCP helper is not an authenticated responsible-process path for real calls. The bridge therefore uses the official signed app-server `mcpServer/tool/call` API.

The API requires a loaded thread ID. The bridge creates an empty, pathless, ephemeral context solely to own the MCP runtime and requires the response to explicitly attest `ephemeral: true`, `path: null`, and `turns: []` before dispatch. It never calls `turn/start`; any `turn/*` or `item/*` event—including one received during teardown—is a fatal architecture violation. The temporary `CODEX_HOME` contains no auth file, API key, user MCPs, plugins, history, memories, or account configuration. A non-websocket dummy model provider points at unreachable loopback, and plugin/remote-control features are disabled, preventing app-server model prewarm and Responses API traffic.

This is direct tool dispatch—not model orchestration.

## Security invariants

1. Only fixed app-bundled Codex and Computer Use client paths are allowed in production.
2. Both binaries pass strict code-signature verification and OpenAI Team ID `2DC432GLL2` checks before dispatch.
3. The helper's exact ten method names and input schemas match the pinned expected inventory before every call.
4. A private mode-`0600` config is loaded before every call and is the sole permission authority.
5. Safe mode permits only `list_apps` and `get_app_state`; full permissions permits all ten methods. Tool arguments, models, and per-call callbacks cannot change mode.
6. App-server uses `approvalPolicy: "never"` in safe mode and `"on-request"` as a relay in full mode. First-party app access is handled deterministically from config: safe declines; full accepts with durable persistence. No model or per-call UI participates.
7. Target selectors resolve to canonical installed bundle IDs before dispatch.
8. Same-app work is excluded across native Pi, generic MCP, and custom state roots with one fixed per-user kernel `lockf` lease namespace.
9. Target focus events, periodic samples, watcher health, queued ASN resolution, and final state are checked. This is post-action detection, not a preventive OS sandbox.
10. One direct request emits one official `mcpServer/tool/call`; no model turn, subagent, shell, web, plugin, prompt, or reachable model transport is available.
11. App-server and helper share one private per-call working directory. Cleanup combines strict ancestry enumeration (preserving partial results) with working-directory ownership recovery, freezes processes to a stable set, kills every owned process, awaits stdio closure, and verifies exit. This still finds a helper reparented by an early app-server exit; enumeration/freeze/exit uncertainty is fatal.
12. Protocol JSONL is bounded before an unterminated line can exceed 8 MB in memory.
13. Per-call `CODEX_HOME` and work directories are mode-private and recursively removed.
14. Only validated text/image result blocks cross to the invoking client. No full-result spill file is written.
15. Audits contain metadata only, including separate `brokerCleanupVerified` and `appLeaseReleased` evidence; lease-release failure changes the audited outcome before surfacing. Arguments, values, screenshots, app-state text, result content, prompts, approvals, credentials, and tokens are forbidden.
16. Policy rejections are audited; audit failure is fatal once a secure state path exists.
17. Runtime and development dependency tarballs are exact-pinned with integrity in `npm-shrinkwrap.json`.

## Permission semantics

Safe is the default and is read-only. Explicit full permissions authorizes all ten methods and arbitrary resolvable app targets without per-call prompts. This broad authorization does not imply that actions are reversible or that focus detection can prevent an already dispatched action. App-state reads can expose visible sensitive information to the calling model.

Mode changes require the explicit Pi command confirmation or the CLI acknowledgement flag and are securely audited. The mode is reloaded before each call; no process reload is required for mode changes.

## Elicitations

Pi and stdio MCP render no per-call approval UI. Safe mode uses `approvalPolicy: "never"`; full mode uses `"on-request"` only to relay the helper request to the deterministic client. Safe returns `decline`. Full permissions returns `accept`, empty content, and `_meta.persist = "always"`; this also allows the official helper to persist the app approval. The approval request count remains audit metadata.

## Visible-content warning

Computer Use is designed to return app state and screenshots. Do not point it at apps containing credentials, payment data, private messages, or customer secrets unless the user explicitly requires that context and accepts model exposure. Audit safety does not make target-app content non-sensitive.

## Supported versions

Only the latest approved release is supported. Version 0.2.0 supports direct local calls in an unlocked macOS session. Targeted local calls while the Mac is locked are not supported.

App-server is experimental and bundle paths or schemas can change. Drift fails closed until reviewed.
