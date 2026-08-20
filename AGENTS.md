# Repository agent guidance

## Product intent

This repository exposes the official signed macOS Computer Use tools to Pi and MCP clients. It is a thin transport adapter. The calling agent selects the official method and arguments. OpenAI Codex and macOS control tool behavior, app access, and platform permissions.

Preserve the official capability surface:

- do not add wrapper permission prompts, app or intent allowlists, action gates, risk classifiers, content inspection, alternate safe modes, or other policy that narrows the official tools
- do not add defence-in-depth because a hypothetical safeguard is possible
- add wrapper logic only when the transport, official component compatibility, zero-model-turn architecture, process lifecycle, or a concrete user-visible bug requires it
- prefer removing accidental wrapper policy when Thomas explicitly approves that contract change

## Existing wrapper behavior

The earlier background-computer-use wrapper introduced canonical app resolution, same-app locking, focus completion telemetry, and metadata-only audit. Version 0.3.4 retained all four. The maintainer subsequently approved removing app rewriting, locking, and focus telemetry because they narrowed or complicated the official capability surface. Do not reintroduce them as wrapper policy. Metadata-only audit remains observability, not an authorization boundary.

Fix concrete compatibility failures in the supported transport when needed. Do not broaden wrapper behavior based only on synthetic or adversarial possibilities.

Signature and Team ID verification, the signed responsible-process path, schema compatibility checks, zero-turn attestation, isolated temporary state, and process cleanup support the official transport and architecture. Keep them within that role. Do not turn them into a general security framework.

## Review standard

Review for material user outcomes and realistic regressions in the supported production path.

- only report a blocking finding when it is reachable under normal supported inputs, or when evidence shows realistic exploitability and material effect
- distinguish correctness and compatibility bugs from optional robustness or defence-in-depth
- do not block a focused compatibility fix on unrelated hardening, speculative malformed input, or a stronger wrapper boundary
- validate the exact diff and relevant end-to-end path
- do not infer failure from a synthetic parser case when the producing system cannot realistically emit it

A request to review a pull request authorizes local inspection and a report to the requester. It does not authorize a GitHub post. Before submitting a review, comment, reaction, issue, or suggested change, show Thomas the exact proposed text and get his explicit approval to post it.

## Development

Use the documented verification chain:

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

Use benign real applications for live acceptance. Keep changes tied to the requested outcome. Preserve the official ten-tool contract and no-permissions behavior unless Thomas explicitly asks to change them.
