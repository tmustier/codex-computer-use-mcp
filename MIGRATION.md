# Migration and rollback

Version 0.2.0 is a breaking architecture change. It replaces the aggregate nested-model tool with ten direct typed tools. The direct implementation passed immutable exact-head review and rollback-safe activation before release. Follow this guide to move from version 0.1.0.

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

The source adapter starts only in no-permissions mode: all ten methods are available and the wrapper opens no approval UI. Use only benign real apps whose persistent first-party access is already configured. Do not use disposable harnesses as acceptance evidence.

## Migrate to version 0.2.0

1. Back up `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`, and the installed 0.1 package or extension directory.
2. Record the installed version and verify that npm resolves `codex-computer-use-mcp@0.2.0` exactly.
3. Remove or disable the 0.1 aggregate adapter and generic MCP registration.
4. Install `npm:codex-computer-use-mcp@0.2.0`.
5. Remove any legacy direct `config.json`; the new build ignores it and has no mode selector.
6. Start a fresh Pi process; do not rely on hot-reloading a security-boundary change.
7. Verify `/computer-use-status` reports:
   - `permissionMode: "no-permissions"`;
   - `approvalPrompts: false`;
   - all ten `availableMethods`;
   - `brokerVerified: true`;
   - `nestedModel: false`;
   - `modelUsage: false`;
   - `ephemeralZeroTurnRuntimeContextRequired: true`.
8. Run `computer_use_list_apps` and `computer_use_get_app_state` against a benign real app with external focus sampling while the Mac is unlocked.
9. Exercise mutating methods on benign disposable content, restore app state, then check audits and process cleanup.

Do not copy old safe/full configuration into the new state root. No-permissions is compiled as the sole unrestricted, no-wrapper-prompt interface.

Version 0.2.0 does not support targeted local Computer Use while the Mac is locked. OpenAI reserves locked use for active trusted turns started from a connected device. See the [locked-screen limitation](README.md#locked-screen-limitation).

## Rollback

1. Stop the current Pi process.
2. Confirm no direct app-server/client/focus/lock process remains.
3. Remove or disable the 0.2 package registration.
4. Restore the backed-up 0.1 package/config registration byte-for-byte.
5. Start a fresh Pi process.
6. Verify the old status command and installed hash.
7. Preserve both private audit directories locally; never merge their content or publish it.

Direct state can be removed only after rollback evidence is captured and no process references it. The fixed per-user lock directory can likewise be removed only when no direct call or `lockf` process exists. These paths contain configuration/content-safe metadata and hashed lock ownership—not credentials.

## Generic MCP gateway

If Pi uses `mcp.json`, retain `directTools: false`. Use the exact `0.2.0` package shown in `integrations/pi/mcp.json.example`. During source acceptance, use a distinct temporary server name and source path, then remove it. The direct Pi adapter is the primary live path; do not leave the version 0.1 aggregate server active after the switch.
