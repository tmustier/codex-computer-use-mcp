#!/usr/bin/env bash
set -euo pipefail
SOURCE_AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [[ ! -f "$SOURCE_AUTH" ]]; then
  echo "Codex auth.json is unavailable; use the official ChatGPT/Codex app UI for approval instead." >&2
  exit 1
fi
ROOT=$(mktemp -d /tmp/codex-cu-approval.XXXXXX)
chmod 700 "$ROOT"
mkdir -m 700 "$ROOT/work"
ln -s "$SOURCE_AUTH" "$ROOT/auth.json"
cat >"$ROOT/config.toml" <<'TOML'
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
approval_policy = { granular = { sandbox_approval = false, rules = false, mcp_elicitations = true, request_permissions = false, skill_approval = false } }
sandbox_mode = "read-only"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
multi_agent = false
memories = false
hooks = false
shell_snapshot = false
remote_plugin = false

[history]
persistence = "none"

[analytics]
enabled = false

[otel]
exporter = "none"
log_user_prompt = false

[mcp_servers.computer-use]
enabled = true
command = "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
args = ["mcp"]
cwd = "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use"
enabled_tools = ["list_apps", "get_app_state"]
TOML
chmod 600 "$ROOT/config.toml"
printf '%s\n' "$ROOT"
