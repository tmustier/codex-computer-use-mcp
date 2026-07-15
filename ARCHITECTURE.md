# Direct architecture and boundary inventory

## Official API evidence

The architecture uses public source and the installed signed binaries; it does not speak a private Computer Use socket protocol.

At OpenAI Codex source commit [`5c19155cbd93bfa099016e7487259f61669823ff`](https://github.com/openai/codex/tree/5c19155cbd93bfa099016e7487259f61669823ff):

- the app-server documentation describes initialization, ephemeral threads, and the distinct `turn/start` operation that begins model work ([README lines 74–81](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server/README.md#L74-L81));
- it documents `mcpServer/tool/call` as a direct call to a configured MCP tool ([README line 238](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server/README.md#L238));
- the typed request contains `thread_id`, `server`, `tool`, and `arguments`—not a prompt or model request ([protocol lines 97–110](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L97-L110));
- the implementation loads the thread runtime and invokes `thread.call_mcp_tool(...)` directly ([processor lines 455–474](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server/src/request_processors/mcp_processor.rs#L455-L474));
- downstream structured elicitation is an explicit client capability rather than implicit approval ([README lines 89–94](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server/README.md#L89-L94)).

The installed CLI labels app-server experimental. This project therefore verifies the current method and upstream schemas on every call and fails closed on drift.

## Live architecture probe

A raw stdio client can initialize the signed `SkyComputerUseClient` and list all ten tool schemas, but a real `list_apps` call from an ordinary Node parent returns:

```text
Computer Use server error -10000: Sender process is not authenticated
```

The same read-only call through signed app-server `mcpServer/tool/call` succeeded while app-server ran with an empty isolated `CODEX_HOME`:

- all ten exact tools discovered;
- one `mcpServer/tool/call`;
- 39 apps returned;
- ephemeral context explicitly attested `ephemeral: true`, `turns: []`, and `path: null`;
- no `turn/start`, `turn/*`, or `item/*` model activity;
- no account auth file or model API credential available to app-server;
- a dummy provider with `supports_websockets = false` and unreachable loopback base URL;
- plugin and remote-control features disabled;
- trace/network sampling showed no app-server Responses API connection or model request after those controls (the separate official Computer Use service may use its own network transport).

This is the narrow official boundary: direct calls require a loaded thread runtime ID in the current API, but do not require a conversation turn or model generation. Literal removal of the thread-shaped runtime object would require an upstream app-server API change.

## Sender-authentication differential

A supported fake stdio MCP server was substituted only to observe the app-server's public downstream envelope shape. App-server used:

- MCP protocol `2025-06-18`;
- `clientInfo` name/title/version identifying `codex-mcp-client` / Codex / the installed CLI;
- standard `elicitation.form` and `elicitation.url` capability keys;
- standard progress metadata on `tools/list`;
- standard progress metadata plus public app-server-added `threadId` metadata on `tools/call`.

An ordinary MCP SDK client then repeated a read-only raw-helper call with the same client identity, capability shape, protocol behavior, and public `progressToken`/random `threadId` metadata shape. The helper still returned `-10000 Sender process is not authenticated`. Changing documented handshake fields therefore does not repair raw dispatch.

The relevant construction difference is the macOS responsible-process chain:

- unsupported: ad-hoc/no-Team-ID Node parent → signed helper;
- supported: Node/Pi → strict-valid OpenAI-signed app-bundled Codex (`2DC432GLL2`) → strict-valid OpenAI-signed helper (`2DC432GLL2`).

Process sampling confirmed the helper children were direct descendants of signed app-server; helper processes may create their own process groups. App-server and helper therefore share one private per-call cwd. Cleanup preserves partial ancestry results, recovers any reparented process by that unique cwd, freezes the owned set to stability, then kills and verifies every process rather than assuming one PGID. Enumeration, freeze, or exit uncertainty fails cleanup closed. The app-server has the expected sandbox/application-group entitlement keys; the helper has OpenAI application/team identifiers, application groups, and keychain-access-group entitlements. Ordinary Node has no Team ID or entitlement set. The service's peer audit token is not exposed through the supported MCP layer. No private socket inspection, identity spoofing, copied signing material, re-signing, injection, or TCC change was attempted. The remaining enforcement boundary is therefore OS peer/responsible-process identity, not a missing public JSON field.

Command, environment, cwd, and config differences were also isolated: both paths invoke the same signed helper with `mcp`; the accepted path gives it a signed parent plus a private fixed cwd/config environment. Matching public MCP fields did not alter the raw error, while the signed-parent path succeeds without model credentials.

## Process path

```text
Pi model
  └─ chooses computer_use_<method> and typed arguments
      └─ local direct service
          └─ signed app-bundled `codex app-server --stdio`
              ├─ empty ephemeral runtime context (zero turns; no transcript)
              └─ `mcpServer/tool/call`
                  └─ signed SkyComputerUseClient `mcp`
                      └─ official Computer Use service
                          └─ target macOS app
```

Forbidden primary-path methods are enforced by code and tests:

```text
turn/start
turn/steer
turn/resume model work
codex exec
codex mcp-server model tools
nested prompts or result summaries
```

## Restriction inventory

| Released wrapper restriction | Classification | Direct design |
|---|---|---|
| Fixed ChatGPT/Codex/client paths | **official-required** | retained and verified |
| Strict signatures and OpenAI Team ID | **security-essential** | retained |
| Signed-parent/responsible-process chain | **official-required** | retained through signed app-server |
| Private Sky socket/native-pipe access | **unsupported/private** | prohibited |
| Nested Codex model and prompt | **compatibility-only** | removed |
| Model selection and reasoning effort | **compatibility-only** | removed; dummy unreachable provider prevents model transport |
| Responses websocket prewarm on empty thread | **accidental app-server behavior** | disabled with non-websocket dummy provider |
| Plugin/remote-control startup networking | **accidental app-server behavior** | corresponding features disabled |
| Model-written multi-step task plan | **compatibility-only** | removed |
| Model result schema/summary | **compatibility-only** | removed |
| Streamed model-event target/method validation | **compatibility-only** | replaced by pre-dispatch typed call validation |
| Per-operation tool allowlists and call budgets | **compatibility-only** | one typed method per direct request |
| Task text, cleanup instructions, required-capabilities fields | **compatibility-only** | removed |
| Dictionary-only special policy | **accidental** | removed |
| Wrapper app/intent allowlists in full mode | **accidental** | absent |
| Safe/full wrapper modes | **compatibility-only** | removed; one durable no-permissions interface exposes all ten methods |
| Wrapper approval prompts/configuration | **compatibility-only** | removed; no command, config, environment, or per-call selector remains |
| Official first-party app access | **official-required** | signed service elicitations are forwarded to the invoking client; never auto-accepted or silently declined |
| macOS TCC | **official-required** | retained; never modified |
| Exact ten-tool inventory/schema | **security-essential** | retained and checked before each call |
| Canonical bundle identity | **security-essential** | retained before targeted dispatch |
| Same-app kernel lock | **security-essential** | retained in one fixed per-user namespace shared across Pi/MCP state roots |
| Automatic background app launch | **accidental** | removed; the official tool owns app behavior |
| Global focus watcher and final sample | **security-essential detection** | retained |
| Timeout/cancellation process-tree termination | **security-essential** | retained with strict enumeration, freeze, kill, stdio-close, and exit verification |
| Per-call temporary worker cleanup | **security-essential** | retained with isolated `CODEX_HOME` |
| Codex token usage accounting | **compatibility-only** | removed; no model turn exists |
| Content-safe private audit | **security-essential** | retained with direct-call fields |
| Full-result spill files | **unsafe/accidental** | prohibited; truncation is in-memory only |
| Browser-host integration | **out of scope** | unchanged |

## No-permissions and elicitation boundary

No-permissions is the sole interface and means unrestricted wrapper dispatch with no wrapper approval prompt. All ten methods are registered. No config file, environment value, slash command, CLI mode switch, or tool argument selects another route.

App-server is created with `approvalPolicy: "never"` so the wrapper does not generate Codex approval prompts. The broker still handles `mcpServer/elicitation/request` from the signed downstream service. Pi advertises OpenAI-form support and renders form, OpenAI-form, and URL requests through its UI. Generic stdio MCP forwards standard form and URL requests as `elicitation/create` to the invoking MCP client. The response path preserves `accept`, `decline`, `cancel`, structured content, and response metadata; no callback or compatible UI yields `cancel`, never an invented decline.

## Output boundary

Only official `text` and `image` MCP blocks are accepted. They are returned to the invoking client because app state and screenshots are the requested capability. They are never copied to audit, logs, temp files, or structured metadata. Text is truncated in memory at Pi's standard 50KB/2000-line bound; the full text is not persisted.

## Package name

Version 0.2.0 keeps the repository and npm package name `codex-computer-use-mcp` for continuity with version 0.1.0. Pi-owned typed tools are now the primary product path. OpenAI's signed Codex app-server remains an implementation boundary, not the planner.

Any future package or repository rename would be a separate distribution change and would require maintainer approval.
