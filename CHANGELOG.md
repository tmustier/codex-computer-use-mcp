# Changelog

This changelog records user-visible changes from version 0.3.2 onwards.

## Unreleased

### Fixed

- Remove the install-time build that could delete the published `dist` directory.
- Report the package version from `package.json` in both MCP protocol identities.
- Support npm 12 source installs and package inspection with `package-lock.json` and the current `npm pack --json` format.
- Preserve one official app-use session across `get_app_state` and multi-action sequences using the same app selector in both Pi and generic MCP.

### Changed

- Keep TypeScript and Node.js types in development dependencies instead of installing them for consumers.
- Derive Pi tool parameters from the same schemas used by the MCP server.
- Dispatch directly instead of blocking on helper inventory, descriptions, annotations, or compatible schema drift.
- Remove arbitrary protocol-line and result-size limits, stale Dictionary verification, and redundant no-permissions configuration code.
- Pass app selectors and key expressions through unchanged, and accept compatible additional tool arguments.
- Remove legacy canonical app rewriting, same-app kernel locking, and focus telemetry.
- Keep Pi's 50KB/2,000-line context limit while saving complete truncated text privately under `/tmp`; screenshots are never spilled.

## 0.3.4 - 2026-07-27

### Fixed

- Match native Computer Use focus behavior: already-frontmost targets, focus changes, and unavailable legacy focus telemetry no longer block or override official tool results. Focus observations remain available in metadata-only audit and response details.

## 0.3.3 - 2026-07-27

### Fixed

- Support the macOS 27 `lsappinfo` `bundleID` output so frontmost-app detection can proceed to official Computer Use dispatch. [Brad Hallett](https://github.com/bradhallett) contributed this fix in [PR #6](https://github.com/tmustier/codex-computer-use-mcp/pull/6).

### Documentation

- Clarify that this package is a thin transport adapter and distinguish official transport requirements from retained legacy wrapper behavior in [PR #12](https://github.com/tmustier/codex-computer-use-mcp/pull/12).
