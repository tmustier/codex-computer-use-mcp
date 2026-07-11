# Proof and acceptance record

This records evidence for the standalone MCP extraction. It does not guarantee compatibility with future ChatGPT macOS versions.

## Supported path

```text
MCP client → wrapper → app-bundled signed Codex CLI → signed SkyComputerUseClient → official Computer Use service
```

Direct unsigned access was rejected by sender authentication. The wrapper does not bypass that boundary. It verifies the fixed app-bundled Codex and Computer Use client with `codesign --verify --strict` and OpenAI Team ID `2DC432GLL2` before each run.

## Preventive-boundary finding

An independent `gpt-5.6-sol`/`xhigh` review of the first standalone candidate found that streamed target and argument checks occur after official-client dispatch. A model deviation could therefore reach a different already-approved app before the wrapper killed the worker.

A local MCP proxy was prototyped and proved capable of rejecting a wrong target before forwarding. It was not adopted: making the unsigned proxy the official client's parent breaks the signed-parent sender-authentication chain and caused live Computer Use to fail. Injection, re-signing, credential extraction, and authentication bypass were rejected as out of bounds.

The public authorization model was changed instead:

- safe mode is list-only;
- all targeted modes are rejected and audited before worker launch;
- full-permissions mode is explicitly acknowledged broad authorization;
- streamed target/method/argument/focus/cleanup checks are documented as post-dispatch detection and completion criteria, not a preventive sandbox.

## Other review remediation

The same review found and prompted fixes for:

- incomplete operations returning a non-error tool status;
- policy-validation failures missing audits;
- lease-release failure suppressing the audit attempt;
- cancellation losing available runner metadata;
- ASN lookup failures being permanently deduplicated;
- final focus sampling not draining an in-flight sample;
- caret-ranged published dependencies without a shrinkwrap;
- status claiming a healthy boundary without verifying the signed broker;
- insufficient release provenance guidance.

Regression tests cover each applicable code path.

## Test and host evidence

The original reviewed core demonstrated:

- strict TypeScript compilation;
- signed broker and ten-method schema verification;
- crash-release and bounded hashed-lock tests;
- streamed event, failed-status, call-budget, timeout, and cancellation tests;
- focus watcher drain/final-query tests;
- secure config/audit no-follow, mode, and fsync checks;
- fresh stopped-Calculator background action with `2 + 2 = 4`, `AC → 0`, cleanup verified, and zero Calculator-frontmost samples;
- all ten official methods, different-app concurrency, same-app exclusion, and cancellation cleanup in earlier benign harness acceptance.

The standalone MCP server additionally demonstrated a real stdio client handshake and safe-mode `list` call:

- result `ok`;
- 39 apps;
- one successful `list_apps` method;
- background preserved;
- separate Codex usage reported;
- private sanitized audit written.

After remediation, release validation must rerun the exact current test count, build, dependency audit, package inspection, read-only list acceptance, Pi adapter smoke, and independent exact-head review. The GitHub release should bind the final commit, tracked-tree aggregate hash, package integrity, host versions, and reviewer verdict.

## Release gate

Before publishing:

1. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, and `npm audit --omit=dev`.
2. Inspect `npm pack --dry-run`; verify `npm-shrinkwrap.json` and exact runtime dependency versions are included.
3. Verify ChatGPT/Codex/client signatures and Team ID on the acceptance host.
4. Run fresh stdio MCP `list` acceptance in safe mode.
5. Run one benign stopped-app action only after explicitly enabling full-permissions, with external focus sampling and cleanup verification.
6. Check for leaked workers, listeners, lock holders, owner records, and harness apps.
7. Independently review the exact release tree. Do not publish with unresolved P0/P1/P2 findings.
8. Record commit, aggregate hash, package integrity, host versions, test count, and review verdict in the release.

## Non-goals

This project does not provide a Sky protocol clone, browser-host integration, credential extraction, TCC automation, app injection, re-signing, sender-authentication bypass, or automatic approval acceptance.
