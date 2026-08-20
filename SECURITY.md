# Security policy

## Reporting a vulnerability

Do not open a public issue for a concrete vulnerability in the supported production path. This includes realistic paths to untrusted component execution, unauthorized wrapper dispatch, credential or result-content exposure, or materially false completion reporting.

Use GitHub private vulnerability reporting. Include the affected commit and version, a small non-sensitive reproduction, and the expected and observed behavior. Provide evidence that the path is realistically reachable. State whether an official action completed before failure. Speculative hardening ideas without a reachable material effect are not vulnerability reports.

Never include credentials, tokens, customer/private content, sensitive screenshots, raw app-state payloads, elicitation contents, or private audit files.

## Architecture boundary

Raw Pi/Node invocation of the signed Computer Use MCP helper is not an authenticated responsible-process path for real calls. The bridge therefore uses the official signed app-server `mcpServer/tool/call` API.

The API requires a loaded thread ID. The bridge requests an ephemeral context solely to own the MCP runtime and requires a usable returned thread ID before dispatch. It never calls `turn/start`; any `turn/*` or `item/*` event—including one received during teardown—is a fatal architecture violation. The temporary `CODEX_HOME` contains no auth file, API key, user MCPs, plugins, history, memories, or account configuration. A non-websocket dummy model provider points at unreachable loopback, and plugin/remote-control features are disabled, preventing app-server model prewarm and Responses API traffic.

This is direct tool dispatch—not model orchestration.

## Authority and non-goals

This package is a thin adapter to official Codex Computer Use. Codex and macOS remain authoritative for tool behavior, app access, and platform permissions. The wrapper must not add permission policy, risk classification, app allowlists, action gates, content inspection, or speculative defence-in-depth.

The earlier background-computer-use wrapper provided canonical app rewriting, same-app locking, and focus telemetry. The maintainer approved removing them because they narrowed or complicated the official capability surface. Do not reintroduce them as wrapper policy. Metadata-only audit remains observability, not an authorization boundary.

## Current adapter invariants

These invariants describe the supported transport, zero-model-turn architecture, current released behavior, process lifecycle, and privacy contract. They are not a general security framework or a mandate to add safeguards.

1. Only the fixed app-bundled Codex path and reviewed official Computer Use layouts are allowed in production. The current client is resolved from the OS account home under `~/.codex/computer-use/`; `HOME`, `CODEX_HOME`, arbitrary paths, and symlinked layouts are not accepted. The former exact plugin-bundle layout is considered only when the current component is absent.
2. Both binaries pass strict code-signature verification and OpenAI Team ID `2DC432GLL2` checks before dispatch. A present current-layout client that fails verification never falls back.
3. The adapter exposes ten typed Computer Use methods, preserves compatible additional arguments, and does not block dispatch because descriptions, annotations or schema metadata drift.
4. `no-permissions` is the only wrapper policy: all ten methods are exposed and no wrapper permission prompt is opened.
5. There is no config file, environment override, command, tool argument, per-call branch, or alternate safe/full route that an agent can select.
6. App-server uses the official Full access combination, `approvalPolicy: "never"` plus `sandbox: "danger-full-access"`. The pinned Codex host automatically accepts empty-schema MCP approval elicitations, so normal first-party app-access checks proceed without prompts. The wrapper does not synthesize this response or edit persistent per-app approvals. Any elicitation app-server emits is forwarded faithfully; an unavailable client cancels.
7. App selectors and key expressions pass to the official service unchanged. There is no wrapper app allowlist, canonical app rewrite, same-app kernel lock, or focus policy.
8. One direct request emits one official `mcpServer/tool/call`; no model turn, subagent, shell, web, plugin, prompt, or reachable model transport is available.
9. App-server and helper share one private broker-session working directory. Pi and generic MCP may retain that session across `get_app_state` and subsequent actions using the same app selector. Pi closes it when the agent settles or the session shuts down; generic MCP closes inactive sessions after two minutes or on disconnect. Cleanup combines strict ancestry enumeration with working-directory ownership recovery, freezes processes to a stable set, kills every owned process, awaits stdio closure, and verifies exit. A verified cleanup failure poisons that executor so it cannot dispatch another call.
10. Per-call audit records report `brokerCleanupVerified=false` while a session is deliberately retained. The eventual settle, idle, or disconnect cleanup is enforced by the executor but does not append a separate tool-call audit record.
11. Per-session `CODEX_HOME` and work directories are private and recursively removed.
12. Result blocks cross to the invoking client without content inspection. Pi truncates displayed text at 50KB or 2,000 lines and saves complete text to a mode-0600 file in a private `/tmp` directory. Image data is never spilled.
13. Audits contain metadata only, including `brokerCleanupVerified` evidence. Arguments, values, screenshots, app-state text, result content, temporary output paths, prompts, approvals, credentials, and tokens are forbidden.
14. Policy rejections are audited; audit failure is fatal once a secure state path exists.
15. `package-lock.json` exact-pins source and CI dependencies with integrity. Published consumers use standard npm dependency resolution.

## Permission semantics

### No-permissions

All ten current methods and arbitrary app selectors are available without wrapper permission prompts. Selectors pass unchanged for the official service to resolve. The name means “ask no permission,” not “disable tools.” This is broad authorization and does not imply that actions are reversible.

The mode is compiled as the sole policy. Agent-writable audit state and legacy configuration files cannot change it, and there is no CLI/slash/tool/environment mode selector.

## Elicitations

The bridge starts app-server with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`. This is Codex's Full access policy, not a wrapper-side approximation. Codex 0.144.2 maps the sandbox value to a disabled permission profile and automatically accepts empty-schema MCP approval elicitations before they are emitted to the client. That covers normal Computer Use app-access prompts without mutating the service's persistent approval file.

If app-server emits a form, OpenAI-form, or URL elicitation, Pi renders it and stdio MCP forwards supported standard modes through `elicitation/create`. The wrapper preserves the user/client response. Missing UI or an unsupported client produces `cancel`, never a fabricated decision.

## Visible content

Computer Use returns the official app-state text and screenshots to the invoking client. The wrapper does not inspect, classify, redact, or use that content to narrow the actions authorized by the user's request, and it never writes the content to its audit. When Pi truncates large text, it writes the complete text to a private temporary file and returns that path; screenshots are never spilled.

## Supported versions

Only the latest approved release is supported. Direct local calls require an unlocked macOS session. Targeted local calls while the Mac is locked are not supported.

App-server is experimental and bundle paths or schemas can change. Compatible drift does not block dispatch; incompatible calls surface the official service's error.
