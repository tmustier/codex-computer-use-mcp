# ADR 0001: Keep Code Mode in a standalone MCP process

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

Codex can compose MCP tools through JavaScript Code Mode. Pi's progressive tool disclosure reduces schema context but does not let generated code invoke arbitrary Pi tools. Adding an executor, loader, or batch method here would also break this repository's exact ten-tool Computer Use contract.

We considered existing Pi and MCP implementations:

- `pi-mcp-adapter` has the strongest Pi-facing MCP configuration, OAuth, elicitation, lifecycle, metadata, and rich-result handling, but no Code Mode executor.
- `dmmulroy/pi-mcp` has a clean MCP manager but no Code Mode, no published package, and no detected licence.
- `Hor1zonZzz/pi-codeMode` demonstrates Pi-side JavaScript orchestration but supports only reconstructed built-ins and has no MCP support or tests.
- `pi-code-tool` is a tested Pi-native pattern, but uses Python/Monty and does not aggregate MCP servers.
- Cloudflare's Code Mode packages are strong design references, but their secure executor depends on Cloudflare Dynamic Workers; `cloudflare/mcp` is specific to the Cloudflare API.
- `tool-sandbox` and `tool-sandbox-mcp` provide QuickJS-based execution, but impose a separate capability boundary and the server primarily targets one upstream HTTP gateway.
- `cmcp` is the closest standalone multi-server implementation, but lacks the OAuth, elicitation, sampling, roots, and notification fidelity required here.

## Decision

If we add Code Mode for Pi, implement it as a **separate stdio MCP server** loaded through Pi's existing MCP adapter.

- Do not modify Pi core.
- Do not add Code Mode methods to `codex-computer-use-mcp`; its public Computer Use surface remains the exact ten official tools.
- Let the Code Mode process connect to upstream MCP servers and expose a compact code-execution surface for discovery and composition.
- Give generated code the same filesystem, network, environment, and process authority as the Code Mode server's surrounding Pi environment. Do not add a stricter capability/security sandbox solely around Code Mode.
- Use the standalone MCP process as the fault-containment boundary. Pi can time out, terminate, and restart it if generated code wedges the process. Do not add a child process or isolate per execution without operational evidence that the server boundary is insufficient.
- Preserve upstream MCP behavior across the nested boundary, especially OAuth, cancellation, rich content, and elicitation responses. Never fabricate `accept` or `decline`; unsupported interaction returns `cancel`.

Normal Pi tools remain available directly. This decision adds MCP composition; it does not attempt to turn every Pi tool into a nested Code Mode function.

## Rationale

The process boundary provides the practical reliability benefit—one malformed snippet cannot freeze Pi—without creating an artificial authority mismatch between Pi and Code Mode. A separate security sandbox would constrain only one route while the same agent can already use Pi's deliberately unrestricted tools.

Keeping Code Mode separate also preserves this package's upstream contract, works with agent-agnostic MCP clients, and avoids coupling the implementation to Pi internals.

## Consequences

- Code Mode is a separate package and lifecycle from Computer Use.
- The first implementation must close the protocol-fidelity gaps found in existing standalone proxies rather than adopting one unchanged.
- Pi's MCP adapter remains responsible for the outer client connection and UI; the Code Mode server remains responsible for its upstream MCP connections and execution lifecycle.
- Process timeout, termination, restart, cleanup, and end-to-end elicitation tests are release requirements.
- Additional execution isolation remains an evidence-driven future option, not a default architectural requirement.
