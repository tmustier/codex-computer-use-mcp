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

No attempt was made to forge sender identity, invoke a private pipe/socket, re-sign code, inject into a process, extract credentials, or alter TCC.

### Positive official app-server probe

The same signed helper through official app-server `mcpServer/tool/call` succeeds. Repeated read-only probes established:

- exact ten-tool inventory;
- one direct `list_apps` call;
- empty ephemeral context: `turns: 0`, `path: null`;
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
- default elicitation decline and explicit handler forwarding;
- fatal rejection of model-turn notifications;
- cancellation process-group termination;
- safe read-only dispatch and pre-dispatch mutation rejection;
- full-permissions absence of wrapper app/intent/action gates;
- canonical bundle-ID dispatch;
- target focus violation fail-closed behavior;
- official error preservation;
- private metadata-only audits with no arguments/results;
- secure config/audit no-follow and mode checks;
- kernel same-app exclusion, race behavior, crash release, and bounded lock filenames;
- focus-event ASN retry/drain behavior;
- stdio MCP inventory/status and safe mutation rejection;
- Pi source registration for every direct capability with no nested planner reference.

## Fresh-Pi real-app acceptance

A fresh `pi -ne -e <source adapter> --no-session` process using the branch build exercised all ten tools sequentially against a real background TextEdit document with disposable local content:

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

## Release-quality gate

This branch must not merge, install, switch live config, publish npm, rename the package/repository, or create a GitHub release during this task.

Candidate validation completed before independent review:

- `npm ci`: pass;
- `npm run check`: pass;
- `npm run check:pi`: pass;
- `npm test`: 33/33 pass;
- `npm run build`: pass;
- `npm audit --omit=dev`: zero vulnerabilities;
- `npm pack --dry-run`: 36 intended files, shrinkwrap present, no removed nested-runner artifact;
- public-source scrub: no secrets, private absolute paths, or machine identifiers found;
- fresh-Pi real-app acceptance: pass as above.

Remaining gate: independent pristine exact-head `gpt-5.6-sol`/`xhigh` security and architecture review, then open a PR and stop merge-ready. Record the final commit, tree, tracked-content aggregate, package integrity, and reviewer P0–P3 verdict before opening the PR.

## Non-goals

No private Sky protocol clone, browser-host integration, credential extraction, TCC automation, app injection, re-signing, sender-auth bypass, automatic approval acceptance, nested model fallback, or tool-result persistence.
