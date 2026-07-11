# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could weaken code-signing checks, approval boundaries, target isolation, focus guarantees, audit integrity, or cleanup behavior.

Use GitHub's private vulnerability reporting for this repository. Include:

- affected version and ChatGPT macOS app version;
- macOS and Node.js versions;
- the smallest non-sensitive reproduction;
- expected versus observed policy behavior;
- whether any app state changed or cleanup was unverified.

Never include credentials, tokens, private/customer content, screenshots containing sensitive data, raw app-state payloads, or private audit files.

## Security invariants

A fix must preserve all of these invariants:

1. Only the fixed OpenAI app-bundled Codex and Computer Use client paths may broker a run.
2. Both binaries must pass strict code-signing verification and OpenAI Team ID checks.
3. First-party OpenAI and macOS approvals remain authoritative and are never self-accepted.
4. Safe mode fails closed for blocked apps/intents, unresolved identity risk, and missing user-elicitation support.
5. The target app must not become frontmost.
6. Calls must stay inside the mode-specific Computer Use allowlist, target lease, argument constraints, and call budget.
7. Same-app work must remain kernel-excluded.
8. Timeout and cancellation must terminate the full worker process group.
9. Audit records must remain private and content-safe; audit failure is fatal.
10. Full-permissions mode must remain explicit and must not disable technical or first-party controls.

## Supported versions

Only the latest release is supported. Because the project depends on bundled app internals, compatibility is evaluated against current ChatGPT macOS releases rather than guaranteed indefinitely.
