# Migration and rollback

Version 0.2 is a breaking architecture change. It must remain off the live Pi path until an immutable exact-head review returns no P0/P1/P2 blocker. After that gate, an exact-head push to `main` and rollback-safe local switch are authorized; npm publication, tags, GitHub releases, and renames are not.

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

Start in safe mode. Use only benign real apps and official first-party approvals. Do not use disposable harnesses as acceptance evidence.

## Reviewed exact-head migration

Only after the independent no-blocker review, and only while `main` still identifies the reviewed commit:

1. Back up `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`, and the installed 0.1 package/extension directory.
2. Record the reviewed commit/tree and verify the pushed `main` commit matches byte-for-byte.
3. Remove or disable the 0.1 aggregate adapter and generic MCP registration.
4. Install the reviewed 0.2 source from the exact pushed commit without publishing a new npm version.
5. Leave direct state in safe mode initially.
6. Start a fresh Pi process; do not rely on hot-reloading a security-boundary change.
7. Verify `/computer-use-status` reports:
   - `brokerVerified: true`;
   - `nestedModel: false`;
   - `modelUsage: false`;
   - `ephemeralZeroTurnRuntimeContextRequired: true`.
8. Run read-only `computer_use_list_apps` and `computer_use_get_app_state` against a benign real app with external focus sampling.
9. Enable full-permissions only through the explicit interactive command if approved.
10. Exercise mutating methods on benign disposable content, restore app state, then check audits and process cleanup.

Do not copy the old full-permissions file into the new state root. Full mode must be re-acknowledged for the direct surface.

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

If Pi uses `mcp.json`, retain `directTools: false`. During source acceptance, use a distinct temporary server name and source path. Remove that temporary entry after acceptance. The reviewed direct Pi adapter is the primary live path; do not leave the released aggregate server active after the rollback-safe switch.
