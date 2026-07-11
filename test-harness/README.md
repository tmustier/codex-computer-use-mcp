# CUA Harness test apps

Two disposable native AppKit apps used only to validate the complete signed Codex Computer Use surface without touching user data.

Controls expose:

- button press (`click`)
- a button menu (`perform_secondary_action` / `AXShowMenu`)
- editable fields (`set_value`, `select_text`, `type_text`)
- scroll area (`scroll`)
- slider (`drag`)
- local key monitor (`press_key`)
- status label for read-back (`get_app_state`)
- reset button for cleanup

Build:

```bash
./build.sh ./build
```

This creates ad-hoc-signed `CUA Harness A.app` and `CUA Harness B.app` with distinct bundle IDs. Signing these disposable target apps does not alter or bypass Codex/Sky identity; the official Computer Use client/service remain untouched.

The apps have no network, file persistence, communications, authentication, payment, or deletion behavior. Remove the build directory after live proof.

For the first-party approval handoff, `run-approval-tui.sh` creates an isolated temporary Codex home, symlinks (does not copy) the existing auth file, enables only read-only Computer Use inspection, and removes the temporary home automatically when the official TUI exits.
