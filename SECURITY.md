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
4. Safe mode allows only `list_apps` and `get_app_state`; mutation rejects before identity resolution or process spawn.
5. Full-permissions requires explicit acknowledgement but has no wrapper app, intent, task, or action allowlist.
6. First-party OpenAI/TCC approvals remain authoritative and are never self-accepted.
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

### Safe

Read-only wrapper policy: `list_apps` and `get_app_state`. App-state reads can expose visible sensitive information to the calling model. Safe means non-mutating at the official tool level, not confidential-data isolation.

### Full-permissions

All ten official methods and arbitrary resolvable app targets. Full mode is broad authorization. It does not imply that actions are reversible or that focus detection can prevent an already dispatched action.

## Elicitations

The Pi adapter forwards only bounded standard form fields to interactive Pi UI. Field count, keys, enum cardinality/bytes, strings, numbers, and local UI duration are capped; declared string/numeric bounds are enforced. Boolean and final confirmations use an explicit abort signal so timeout cannot be mistaken for a human-entered `false`. It defaults to decline and declines unsupported, URL, headless, proprietary, oversized, or malformed forms. A human must select/input values and confirm submission.

The stdio MCP wrapper cannot present Pi UI and declines first-party elicitations. Persistent approvals belong in official ChatGPT Computer Use settings.

## Visible-content warning

Computer Use is designed to return app state and screenshots. Do not point it at apps containing credentials, payment data, private messages, or customer secrets unless the user explicitly requires that context and accepts model exposure. Audit safety does not make target-app content non-sensitive.

## Supported versions

Only the latest approved release is supported. App-server is experimental and bundle paths/schema can change; drift fails closed until reviewed.
