# Migration and rollback

Version 0.2 is a breaking architecture change. This branch does not install, reload, switch live configuration, merge, publish, or release it.

## What changes

| 0.1 released surface | 0.2 direct surface |
|---|---|
| `background_computer_use` aggregate task | ten `computer_use_<method>` Pi tools |
| `background_computer_use_status` | `/computer-use-status` and MCP `computer_use_status` |
| `/background-computer-use-mode` | `/computer-use-mode` |
| safe mode: list only | safe mode: list + app-state read |
| nested model plans and summarizes | Pi calls one official typed method per tool call |
| separate Codex model usage | no nested model/token usage |
| state under wrapper-specific old path | isolated direct state under `~/.direct-computer-use` or Pi agent direct state |

## Pre-migration checks

1. Stop all current aggregate Computer Use calls.
2. Record the installed package/extension version and permission mode.
3. Back up the Pi package/config files without copying audit content into tickets or chat.
4. Confirm no `pi-native-app-worker.*`, `SkyComputerUseClient mcp`, `codex app-server`, `lockf`, or focus-listener process from the old adapter is active.
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

Start in safe mode. Use only benign real apps and official first-party approvals. Do not use disposable harnesses as acceptance evidence.

## Eventual opt-in migration

Only after merge/release approval:

1. Back up `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`, and the installed 0.1 package/extension directory.
2. Remove or disable the 0.1 aggregate adapter registration.
3. Install the approved exact 0.2 package version.
4. Leave direct state in safe mode initially.
5. Start a fresh Pi process; do not rely on hot-reloading a security-boundary change.
6. Verify `/computer-use-status` reports:
   - `brokerVerified: true`;
   - `nestedModel: false`;
   - `modelUsage: false`;
   - `ephemeralZeroTurnRuntimeContextRequired: true`.
7. Run read-only `computer_use_list_apps` and `computer_use_get_app_state` against a benign real app with external focus sampling.
8. Enable full-permissions only through the explicit interactive command if approved.
9. Exercise mutating methods on benign disposable content, restore app state, then check audits and process cleanup.

Do not copy the old full-permissions file into the new state root. Full mode must be re-acknowledged for the direct surface.

## Rollback

1. Stop the current Pi process.
2. Confirm no direct app-server/client/focus/lock process remains.
3. Remove or disable the 0.2 package registration.
4. Restore the backed-up 0.1 package/config registration byte-for-byte.
5. Start a fresh Pi process.
6. Verify the old status command and installed hash.
7. Preserve both private audit directories locally; never merge their content or publish it.

Direct state can be removed only after rollback evidence is captured and no process references it. It contains configuration and content-safe metadata, not credentials.

## Generic MCP gateway

If Pi uses `mcp.json`, retain `directTools: false`. During migration, use a distinct temporary server name and source path. Remove the temporary entry after acceptance; do not silently replace the released server command before the separate live-switch gate.
