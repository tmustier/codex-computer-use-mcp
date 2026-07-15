# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could weaken signing, contract verification, no-permissions dispatch, first-party access handling, app identity, locking, focus telemetry, cleanup, or audit integrity.

Use GitHub private vulnerability reporting. Include the affected commit/version, the smallest non-sensitive reproduction, expected versus observed behavior, and whether an official action completed before failure.

Never include credentials, tokens, customer/private content, sensitive screenshots, raw app-state payloads, elicitation contents, or private audit files.

## Architecture boundary

Raw Pi/Node invocation of the signed Computer Use MCP helper is not an authenticated responsible-process path for real calls. The bridge therefore uses the official signed app-server `mcpServer/tool/call` API.

The API requires a loaded thread ID. The bridge creates an empty, pathless, ephemeral context solely to own the MCP runtime and requires the response to explicitly attest `ephemeral: true`, `path: null`, and `turns: []` before dispatch. It never calls `turn/start`; any `turn/*` or `item/*` event—including one received during teardown—is a fatal architecture violation. The temporary `CODEX_HOME` contains no auth file, API key, user MCPs, plugins, history, memories, or account configuration. A non-websocket dummy model provider points at unreachable loopback, and plugin/remote-control features are disabled, preventing app-server model prewarm and Responses API traffic.

This is direct tool dispatch—not model orchestration.

## Security invariants

1. Only fixed app-bundled Codex and Computer Use client paths are allowed in production.
2. Both binaries pass strict code-signature verification and OpenAI Team ID `2DC432GLL2` checks before dispatch.
3. The helper's exact ten method names and input schemas match the pinned expected inventory before every call; release tests also verify its descriptions and annotations.
4. `no-permissions` is the only wrapper policy: all ten methods are exposed and no wrapper permission prompt is opened.
5. There is no config file, environment override, command, tool argument, per-call branch, or alternate safe/full route that an agent can select.
6. App-server uses the official Full access combination, `approvalPolicy: "never"` plus `sandbox: "danger-full-access"`. The pinned Codex host automatically accepts empty-schema MCP approval elicitations, so normal first-party app-access checks proceed without prompts. The wrapper does not synthesize this response or edit persistent per-app approvals. Any elicitation app-server emits is forwarded faithfully; an unavailable client cancels.
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

### No-permissions

All ten official methods and arbitrary resolvable app targets are available without wrapper permission prompts. The name means “ask no permission,” not “disable tools.” This is broad authorization. It does not imply that actions are reversible or that focus detection can prevent an already dispatched action.

The mode is compiled as the sole policy. Agent-writable audit state and legacy configuration files cannot change it, and there is no CLI/slash/tool/environment mode selector.

## Elicitations

The bridge starts app-server with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`. This is Codex's Full access policy, not a wrapper-side approximation. Codex 0.144.2 maps the sandbox value to a disabled permission profile and automatically accepts empty-schema MCP approval elicitations before they are emitted to the client. That covers normal Computer Use app-access prompts without mutating the service's persistent approval file.

If app-server emits a form, OpenAI-form, or URL elicitation, Pi renders it and stdio MCP forwards supported standard modes through `elicitation/create`. The wrapper preserves the user/client response. Missing UI or an unsupported client produces `cancel`, never a fabricated decision.

## Visible content

Computer Use returns the official app-state text and screenshots to the invoking client. The wrapper does not inspect, classify, redact, or use that content to narrow the actions authorized by the user's request, and it never writes the content to its audit.

## Supported versions

Only the latest approved release is supported. Version 0.3.0 supports direct local calls in an unlocked macOS session. Targeted local calls while the Mac is locked are not supported.

App-server is experimental and bundle paths or schemas can change. Drift fails closed until reviewed.
