# Contributing

Contributions are welcome, especially compatibility fixes, direct-protocol tests, adversarial boundary tests, and clearer host diagnostics.

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
- Add a regression test for every protocol, policy, focus, cleanup, or audit fix.
- Never log or persist arguments, typed values, screenshots, app-state/result content, elicitation contents, prompts, credentials, or tokens.
- Treat focus checks as post-action detection rather than preventive isolation.
- Document fixed ChatGPT bundle paths and upstream schema/API assumptions.
- Include strict core/Pi type checks, tests, build, audit, package inspection, and real-app acceptance evidence.
- Obtain independent exact-head review for security-boundary changes.

Repository/package renaming, merge, npm publication, and GitHub release require separate maintainer approval.

See `ARCHITECTURE.md`, `SECURITY.md`, and `MIGRATION.md`.
