# Direct architecture proof and acceptance record

This file records evidence for the 0.2 direct-tool branch. It is not a compatibility promise for future ChatGPT versions.

## Supported direct path

```text
Pi chooses typed method/arguments
  → local direct service
  → signed app-bundled Codex app-server
  → mcpServer/tool/call
  → signed SkyComputerUseClient
  → official Computer Use service
```

No model turn, prompt, planner, result summarizer, subagent, shell, web tool, user plugin, or Codex auth credential exists on this path.

## Architectural proof

### Negative raw-helper probe

The official helper's stdio MCP handshake succeeds and exposes all ten schemas. A real direct `list_apps` from an ordinary Node parent fails:

```text
Computer Use server error -10000: Sender process is not authenticated
```

Matching the app-server's observed public downstream MCP identity/capability/progress/`threadId` metadata shape in an ordinary raw MCP SDK client still produced the same sender-authentication rejection. Process and signing evidence identified the material difference as ad-hoc/no-Team-ID Node parent versus strict-valid OpenAI-signed app-server parent. The supported layer does not expose the service peer audit token. No attempt was made to forge sender identity, invoke a private pipe/socket, re-sign code, inject into a process, extract credentials, or alter TCC.

### Positive official app-server probe

The same signed helper through official app-server `mcpServer/tool/call` succeeds. Repeated read-only probes established:

- exact ten-tool inventory;
- one direct `list_apps` call;
- empty ephemeral context explicitly attested `ephemeral: true`, `turns: []`, and `path: null`;
- no `turn/start`, `turn/*`, or `item/*` model activity;
- app-server `CODEX_HOME` isolated from the user's Codex home and containing no auth;
- model provider replaced by a non-websocket dummy bound to unreachable loopback;
- plugin and remote-control features disabled;
- trace/network sampling showed no app-server Responses API connection or model request after those controls;
- no nested model-token usage;
- 39 apps returned.

The public OpenAI source basis and permanent links are in `ARCHITECTURE.md`.

## Automated evidence

Current branch tests cover:

- strict TypeScript for core and Pi adapter;
- fixed-path strict signature and Team ID checks;
- exact official ten-tool inventory/schema drift rejection before dispatch;
- direct JSONL request sequence with no `turn/start`;
- isolated credential-free `CODEX_HOME` even when the parent environment contains a model API key;
- production app-server arguments disable model transport, plugins, and remote control;
- private mode-`0600` durable config as the sole permission authority, loaded before every call;
- safe mode read-only enforcement before broker dispatch and full-permissions access to all ten methods;
- deterministic first-party elicitation handling: safe declines; full accepts with durable persistence only for the active ephemeral thread's exact `computer-use` empty-object form, while unexpected server, thread, mode, metadata, and schema fail closed, with no model/UI vote;
- fatal rejection of model-turn notifications, including a notification emitted during teardown;
- strict `ephemeral: true` / `path: null` / `turns: []` response attestation before dispatch;
- pre-buffer rejection of an oversized unterminated protocol line;
- partial-preserving ancestry enumeration plus private-cwd recovery, stable freeze/termination of separately grouped or reparented helpers, and stdio closure;
- full-permissions read/mutation dispatch without per-call gates;
- absence of model/app/intent/action discretion after durable full-permissions is configured;
- canonical bundle-ID dispatch;
- target focus violation fail-closed behavior;
- official error preservation;
- private metadata-only audits with no arguments/results and truthful separate broker/lease cleanup evidence;
- secure audit-directory/file no-follow and mode checks;
- global per-user same-app exclusion across different supported state roots, race behavior, crash release, private lock roots, and bounded lock filenames;
- focus-event ASN retry/drain behavior, including valid events at the start of a single large stdout chunk;
- stdio MCP all-ten inventory/status plus acknowledged durable mode configuration;
- Pi source registration for every direct capability with no nested planner or per-call approval UI.

## Fresh Pi unlocked real-app acceptance

A fresh `pi -ne -e <source adapter> --no-session` process using the branch build exercised all ten tools sequentially in an unlocked macOS session. The target was a real background TextEdit document with disposable local content:

1. `computer_use_list_apps`
2. `computer_use_get_app_state`
3. `computer_use_perform_secondary_action` (`Scroll Down`)
4. `computer_use_scroll` (0.5 page)
5. `computer_use_drag` (visible text selection)
6. `computer_use_set_value`
7. `computer_use_select_text`
8. `computer_use_type_text`
9. `computer_use_click`
10. `computer_use_press_key` (`CMD+A` and `CMD+S`, normalized to official xdotool-style keys)

Evidence:

- 19 strictly sequential direct calls including eight state reads;
- every call `outcome=ok`, `directCalls=1`, `modelTurnsStarted=0`, `ephemeralThread=true`, and `brokerCleanupVerified=true`;
- every targeted call `backgroundPreserved=true`;
- no first-party approval request appeared or was accepted;
- final saved document content exactly `DIRECT COMPUTER USE ACCEPTANCE CLEANUP COMPLETE`;
- 702 external 50ms frontmost samples, all Music, zero TextEdit samples;
- 37 sampled direct app-server process observations, all `app-server --stdio` with the disabled provider; zero `codex exec`/`mcp-server` nested commands;
- zero app-server TCP sockets observed after model/plugin/remote-control transport was disabled;
- zero leaked direct app-server/client/focus/lock processes; zero owner files;
- TextEdit was stopped and the disposable document removed after verification.

Earlier exploratory attempts exposed and fixed two acceptance-quality issues rather than being counted as proof: common `CMD+A` needed normalization to the official `Meta_L+a` key form, and TextEdit state restoration had to be reset before a fresh run. The final evidence above is from the corrected direct path.

## Live durable full-permissions acceptance

Redacted live acceptance was run from the isolated source checkout without recording UI text, image data, arguments beyond the named acceptance app, or other sensitive output.

The initial Excel run used executable commit `bdaed808340bb2af1b23d09afd8fa34e4e67c243`, tree `b90f403f4c62494f1328a8ab7a760ed314632545`. A private mode-`0600` config contained `permissionMode: "full-permissions"`. The official `computer-use` server emitted its empty-object form, the bridge returned exactly `{action: "accept", content: {}, _meta: {persist: "always"}}`, and `computer_use_get_app_state(app="Microsoft Excel")` completed with `outcome=ok`, `directCalls=1`, `approvalRequests=1`, `modelTurnsStarted=0`, `backgroundPreserved=true`, and `brokerCleanupVerified=true`.

Review hardening then restricted acceptance to the active ephemeral thread, exact `computer-use` server, `turnId: null`, exact form mode, `_meta.persist: ["always"]`, and exact `{type: "object", properties: {}}` schema. At executable commit `35b5458b3981ca271508802065d6fdec2608b7e3`, tree `c56818de031fa53b54869d5b3f900df6da633f52`, a fresh unapproved first-party app exercised that validated relay with `approvalRequests=1`, `modelTurnsStarted=0`, and `outcome=ok`. The same exact head then read Excel successfully. Excel's approval had already been durably persisted by the initial acceptance, so this confirming call correctly reported `approvalRequests=0` rather than eliciting again.

The redacted metadata-only Excel audit at that exact executable head recorded:

- `permissionMode=full-permissions` and `authorization=full_permissions_config`;
- canonical app identity `com.microsoft.Excel`;
- signed runtime identity `codex-cli 0.144.0-alpha.4`, client build `1000366`;
- `outcome=ok`, `directCalls=1`, `modelTurnsStarted=0`, and `ephemeralThread=true`;
- `backgroundPreserved=true`, `brokerCleanupVerified=true`, and `appLeaseReleased=true`;
- result content types only (`image`, `text`), with content omitted here.

No model turn, per-call UI decision, TCC mutation, Settings navigation, auth change, or alternate Computer Use surface was used. The evidence-only documentation commit after the executable proof does not change runtime source.

## Review and release status

The direct implementation at commit `98d26f8040f8035a294caa8581d218a33c076990`, tree `01dd30c899863d182bcb0ac3256bd0cc11efc42b`, passed the immutable exact-head review and rollback-safe activation gates. It became the basis for the version 0.2.0 release.

Validation recorded for the reviewed direct implementation:

- `npm ci`: pass;
- `npm run check`: pass;
- `npm run check:pi`: pass;
- `npm test`: 45/45 pass;
- `npm run build`: pass;
- `npm audit --omit=dev`: zero vulnerabilities;
- `npm pack --dry-run`: 36 intended files, shrinkwrap present, no removed nested-runner artifact;
- public-source scrub: no secrets, private absolute paths, or machine identifiers found;
- fresh-Pi real-app acceptance: pass as above.

Independent reviews of earlier revisions found cleanup and coordination gaps: fail-open or partial descendant enumeration, early-exit orphan recovery, state-root-scoped same-app locking, false-success lease-release audit, unverified focus-listener exit, pre-response direct-call accounting, and large-chunk focus-event loss. The current implementation retains those fixes and uses durable safe/full configuration without per-call model or UI approval.

Version 0.2.0 supports direct local calls only in an unlocked macOS session. Targeted calls failed with official error `-10005` during genuine locked-session acceptance. OpenAI limits locked Computer Use to active trusted turns started from a connected device, so locked local use remains follow-up work and is not part of this release.

## Non-goals

No private Sky protocol clone, browser-host integration, credential extraction, TCC automation, app injection, re-signing, sender-auth bypass, model-driven approval, nested model fallback, or tool-result persistence. Full-permissions does deterministically accept the official helper's app-access elicitation because durable config is the sole permission authority.
