# Contributing

Contributions are welcome, especially compatibility fixes, adversarial policy tests, and clearer host diagnostics.

## Setup

```bash
npm ci
npm run check
npm test
npm run build
```

Development and live acceptance require macOS plus the official ChatGPT app. Tests that verify the bundled broker and compile disposable native harnesses are intentionally host integration tests.

## Pull requests

- Keep safe mode list-only; do not add targeted dispatch without a preventive mechanism that preserves official signed-parent authentication.
- Do not add credential extraction, app injection, re-signing, private protocol bypasses, TCC automation, or automatic approval acceptance.
- Add a regression test for every policy or cleanup fix.
- Avoid logging task text, typed values, screenshots, app-state payloads, or model output.
- Document any new fixed ChatGPT bundle path or CLI assumption.
- Include `npm run check`, `npm test`, and `npm run build` results.
- For targeted behavior changes, include a benign stopped-app acceptance and external focus evidence, and label post-dispatch checks honestly.

Security-boundary changes should receive an independent exact-head review before merge. See `SECURITY.md` for private vulnerability reporting.
