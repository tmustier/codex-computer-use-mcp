# Contributing

Contributions are welcome, especially compatibility fixes, direct-protocol tests, realistic regression coverage, and clearer host diagnostics.

## Setup

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

Development and live acceptance require macOS and the official ChatGPT Computer Use component. Acceptance evidence must use benign real apps, not a disposable harness alone.

## Pull requests

- Keep Pi-owned typed methods as the primary path.
- Do not add a nested model, action planner, prompt, subagent, or model-written result summary to direct dispatch.
- Do not use private pipes/sockets, credential extraction, app injection, re-signing, sender impersonation, TCC automation, or automatic approval acceptance.
- Keep app-server in a credential-free isolated `CODEX_HOME` with only official Computer Use configured.
- Add a regression test for each concrete protocol, compatibility, lifecycle, or current-behavior fix.
- Never log or persist arguments, typed values, screenshots, app-state/result content, elicitation contents, prompts, credentials, or tokens.
- Do not add wrapper-side permission policy, risk classification, allowlists, gates, or speculative defence-in-depth on top of official Codex and macOS controls.
- Treat current focus checks as legacy post-action completion telemetry, not preventive isolation or a precedent for further hardening.
- Document reviewed ChatGPT component paths, launcher contracts, and upstream schema/API assumptions.
- Include strict core/Pi type checks, tests, build, audit, package inspection, and real-app acceptance evidence.
- Review material transport or published-behavior changes at the exact head, and keep findings tied to realistic supported paths.

Repository/package renaming, merge, npm publication, and GitHub release require separate maintainer approval.

See `ARCHITECTURE.md`, `SECURITY.md`, and `MIGRATION.md`.
