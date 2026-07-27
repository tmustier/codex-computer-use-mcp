# Migration and rollback

Version 0.2.0 was the breaking direct-tool architecture change from version 0.1.0. Version 0.3.0 added Pi progressive disclosure, version 0.3.1 followed ChatGPT's current per-user Computer Use component layout, version 0.3.2 restored one complete direct Pi surface with shared inspection-action session continuity, version 0.3.3 added macOS 27 compatibility, and version 0.3.4 aligns focus behavior with native Computer Use. Use the relevant section below.

## What changes

| 0.1 released surface | 0.2 direct surface |
|---|---|
| `background_computer_use` aggregate task | ten `computer_use_<method>` Pi tools |
| `background_computer_use_status` | `/computer-use-status` and MCP `computer_use_status` |
| `/background-computer-use-mode` | removed; `/computer-use-status` is read-only |
| safe/full wrapper modes | one durable no-permissions interface: all ten methods, no wrapper prompts |
| nested model plans and summarizes | Pi calls one official typed method per tool call |
| separate Codex model usage | no nested model/token usage |
| state under wrapper-specific old path | isolated direct state under `~/.direct-computer-use` or Pi agent direct state |

## Pre-migration checks

1. Stop all current aggregate Computer Use calls.
2. Record the installed package/extension version and permission mode.
3. Back up the Pi package/config files without copying audit content into tickets or chat.
4. Confirm no `pi-native-app-worker.*`, `SkyComputerUseClient mcp`, `codex app-server`, `lockf`, or focus-listener process from the old adapter is active. The direct adapter uses one fixed private `/tmp/codex-computer-use-mcp-<uid>` lock namespace across Pi and MCP state roots.
5. Keep the old and new adapters from registering overlapping tools in one Pi process.

## Source acceptance without installation

Use a fresh Pi process and the source extension explicitly:

```bash
npm ci
npm run build
CODEX_COMPUTER_USE_HOME="$(mktemp -d)" \
  pi -ne -e /absolute/path/to/integrations/pi/index.ts
```

`-ne` suppresses auto-discovered extensions so the live 0.1 adapter is not loaded. This does not change live Pi configuration.

The source adapter starts only in no-permissions mode: all ten methods are available and the wrapper opens no permission UI of its own. The signed app-server runs with Codex Full access, so normal empty-schema app approval elicitations resolve without a prompt. Any elicitation app-server emits is still shown through Pi and answered only by the user. Use benign real apps for acceptance; do not use disposable harnesses as evidence.

## Migrate to version 0.2.0

1. Back up `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`, and the installed 0.1 package or extension directory.
2. Record the installed version and verify that npm resolves `codex-computer-use-mcp@0.2.0` exactly.
3. Remove or disable the 0.1 aggregate adapter and generic MCP registration.
4. Install `npm:codex-computer-use-mcp@0.2.0`.
5. Remove any legacy direct `config.json`; the new build ignores it and has no mode selector.
6. Start a fresh Pi process; do not rely on hot-reloading a security-boundary change.
7. Verify `/computer-use-status` reports:
   - `permissionMode: "no-permissions"`;
   - `wrapperPermissionPrompts: false`;
   - `officialApprovalPolicy: "full-access"`;
   - `officialAppApprovalHandling: "auto-approved-by-codex-full-access"`;
   - `officialElicitationHandling: "forwarded-if-emitted"`;
   - all ten `availableMethods`;
   - `brokerVerified: true`;
   - `nestedModel: false`;
   - `modelUsage: false`;
   - `ephemeralZeroTurnRuntimeContextRequired: true`.
8. Run `computer_use_list_apps` and `computer_use_get_app_state` against a benign real app with external focus sampling while the Mac is unlocked.
9. Exercise mutating methods on benign disposable content, restore app state, then check audits and process cleanup.

Do not copy old safe/full configuration into the new state root. No-permissions is compiled as the sole unrestricted, no-wrapper-prompt interface.

Version 0.2.0 does not support targeted local Computer Use while the Mac is locked. OpenAI reserves locked use for active trusted turns started from a connected device. See the [locked-screen limitation](README.md#locked-screen-limitation).

## Upgrade from version 0.2.0 to 0.3.0

The MCP contract and signed execution path do not change. The native Pi extension now registers all ten definitions but initially activates only `computer_use_list_apps` and `computer_use_get_app_state`.

1. Upgrade Pi to version 0.80.7 or newer.
2. Back up `~/.pi/agent/settings.json` and the installed 0.2 package directory.
3. Verify that npm resolves `codex-computer-use-mcp@0.3.0` exactly, then install that exact package.
4. Start a fresh Pi process.
5. Verify that the two inspection tools are initially active and the eight interaction tools remain registered but inactive.
6. Call `computer_use_get_app_state` against a benign app while the Mac is unlocked. A successful result should add all eight interaction tools without removing any active tool.
7. Exercise a benign interaction, inspect the private content-safe audit, and verify process cleanup.

The change is context disclosure, not a permission mode. Codex Full access, emitted elicitation forwarding, schemas, and the no-permissions policy remain unchanged.

## Upgrade from version 0.3.0 to 0.3.1

ChatGPT 26.721 moved the signed Computer Use app out of the bundled plugin and into `~/.codex/computer-use/`. Version 0.3.1 follows the official launcher contract while retaining the exact former plugin layout as a compatibility candidate.

1. Verify that npm resolves `codex-computer-use-mcp@0.3.1` exactly, then install that exact package.
2. Start a fresh Pi process. A running Pi process retains the already-loaded extension code.
3. Verify `/computer-use-status` reports `brokerVerified: true`.
4. While the Mac is unlocked, run `computer_use_list_apps` and `computer_use_get_app_state` against a benign real app.

The resolver does not read `HOME` or `CODEX_HOME` and has no arbitrary path override. Missing, symlinked, invalidly signed, or wrong-Team-ID clients fail closed.

## Upgrade from version 0.3.1 to 0.3.2

Version 0.3.2 activates all ten direct Pi tools at session start and retains one verified signed-client session across `get_app_state` and the following action.

1. Verify that npm resolves `codex-computer-use-mcp@0.3.2` exactly, then install that exact package.
2. Start a fresh Pi process; do not rely on hot reload for the retained process lifecycle.
3. Verify all ten `computer_use_*` tools are active through the direct extension binding.
4. With an unlocked Mac and a benign background app, call `computer_use_get_app_state`, then one harmless interaction against the same app.
5. Verify the state and action used one app-server runtime/thread, the action did not report an inactive Computer Use session, focus remained preserved, and cleanup completed.

The exact schemas, strict signature and OpenAI Team ID checks, canonical client and app resolution, Full access policy, zero-turn attestation, inventory validation, kernel lock, focus telemetry, process-tree cleanup, and content-safe audit remain mandatory.

## Upgrade from version 0.3.2 to 0.3.3

Version 0.3.3 accepts both the legacy `CFBundleIdentifier` key and the macOS 27 `bundleID` key from `lsappinfo`.

1. Verify that npm resolves `codex-computer-use-mcp@0.3.3` exactly, then install that exact package.
2. Start a fresh Pi process so it loads the updated extension code.
3. On an unlocked Mac, run `computer_use_get_app_state` against a benign background app and verify that the result succeeds without moving focus.

## Upgrade from version 0.3.3 to 0.3.4

Version 0.3.4 removes the legacy background-only focus gate. Calls now match native Computer Use when a target is already frontmost, changes focus, or focus telemetry is unavailable. Focus observations remain metadata-only telemetry. No configuration migration is required.

1. Verify that npm resolves `codex-computer-use-mcp@0.3.4` exactly, then install that exact package.
2. Start a fresh Pi process so it loads the updated extension code.
3. On an unlocked Mac, make a benign app frontmost, then run `computer_use_get_app_state` followed by `computer_use_press_key` with `ESC` against that same app.
4. Verify both calls succeed, `backgroundPreserved` records `false`, the pair uses one zero-turn ephemeral session, and cleanup completes.

## Rollback

1. Stop the current Pi process.
2. Confirm no direct app-server/client/focus/lock process remains.
3. Remove or disable the current package registration.
4. Restore the backed-up 0.1 package/config registration byte-for-byte.
5. Start a fresh Pi process.
6. Verify the old status command and installed hash.
7. Preserve both private audit directories locally; never merge their content or publish it.

Direct state can be removed only after rollback evidence is captured and no process references it. The fixed per-user lock directory can likewise be removed only when no direct call or `lockf` process exists. These paths contain configuration/content-safe metadata and hashed lock ownership—not credentials.

## Generic MCP gateway

If Pi uses `mcp.json`, retain `directTools: false`. Use the exact `0.3.4` package shown in `integrations/pi/mcp.json.example`. During source acceptance, use a distinct temporary server name and source path, then remove it. The direct Pi adapter is the primary live path; do not leave the version 0.1 aggregate server active after the switch.
