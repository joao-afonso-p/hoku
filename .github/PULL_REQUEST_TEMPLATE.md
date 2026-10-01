## Summary

<!-- What does this change and why? Link the issue: "Closes #123". -->

## Type of change

- [ ] `feat`: new feature
- [ ] `fix`: bug fix
- [ ] `docs`: documentation only
- [ ] `refactor` / `style` / `test` / `chore`
- [ ] New or changed provider integration

## Provider(s) touched

- [ ] None
- [ ] Claude Code (`providers/claude_code.rs`)
- [ ] Codex Desktop (`providers/codex.rs`)
- [ ] Claude Desktop: Cowork or chats (`providers/claude_desktop.rs`)
- [ ] New provider:
- [ ] Launch paths (`launch.rs`) or integrations (`integrations.rs`)

## Validation

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `cd src-tauri && cargo fmt --check`
- [ ] `cd src-tauri && cargo test`
- [ ] `pnpm build`, and `pnpm tauri build --debug --bundles app` for Rust or config changes
- [ ] Docs updated (`README.md`, `docs/`) if behaviour, providers or the security model changed
- [ ] User guide updated (`site/`) for any user-facing change, with new screenshots from `pnpm capture` if the UI changed (see `site/README.md`)

## Privacy and safety

- [ ] No real user data in code, fixtures, tests, logs or screenshots (no real session titles, prompts, emails, ids, or paths with a username)
- [ ] Screenshots, if any, use demo data (Settings → Load demo)
- [ ] No writes to provider stores (`~/.claude`, `~/.codex`, Claude Desktop support folders). Foreign databases are opened read-only
- [ ] No credential or token files are read. Only titles and short (≤200 character) previews are stored
- [ ] No network access added. New ids, paths or URLs reaching a shell or AppleScript are validated and escaped

## Tested on

- macOS version (if you changed macOS paths):
- Chip (Apple Silicon or Intel):
- Linux distribution (if you changed Linux paths):
- Provider app/CLI versions, if relevant:

## Notes for the reviewer

<!-- Anything tricky, trade-offs, follow-ups. -->
