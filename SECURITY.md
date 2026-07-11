# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could weaken code-signing checks, safe-mode dispatch restrictions, approval boundaries, focus guarantees, audit integrity, or cleanup behavior.

Use GitHub's private vulnerability reporting. Include affected versions, the smallest non-sensitive reproduction, expected versus observed behavior, and whether app state changed or cleanup was unverified.

Never include credentials, tokens, private/customer content, sensitive screenshots, raw app-state payloads, or private audit files.

## Authorization model

The signed official client authenticates its parent. An unsigned wrapper cannot synchronously proxy each Computer Use call without breaking that official sender-authentication chain. Streamed target, method, argument, call-budget, focus, and cleanup checks therefore occur after dispatch.

For that reason:

- safe mode is list-only and rejects targeted work before starting Codex;
- full-permissions mode is broad wrapper authorization, not a preventive per-app sandbox;
- post-dispatch validation can fail completion and surface cleanup risk, but cannot undo a mutation;
- official OpenAI app approvals, sensitive-action prompts, and macOS privacy controls remain authoritative.

## Security invariants

1. Only the fixed OpenAI app-bundled Codex and Computer Use client paths may broker a run.
2. Both binaries must pass strict code-signing verification and OpenAI Team ID checks.
3. First-party OpenAI and macOS approvals are never self-accepted.
4. Safe mode dispatches only `list_apps`; every targeted mode fails before worker launch.
5. Full-permissions mode requires explicit acknowledgement and never claims preventive target isolation.
6. The target app must not become frontmost; watcher health, queued events, in-flight samples, and final state are checked.
7. Streamed calls must match the mode allowlist, requested target aliases, argument constraints, and call budget before completion is trusted.
8. Same-app work remains kernel-excluded.
9. Timeout and cancellation terminate the full worker process group and retain available partial metadata.
10. Audits remain private and content-safe; policy rejections are audited, and audit failure is fatal once a secure state path exists.
11. Runtime dependencies are exact-pinned and published with `npm-shrinkwrap.json`.

## Supported versions

Only the latest release is supported. Compatibility is evaluated against current ChatGPT macOS releases rather than guaranteed indefinitely.
