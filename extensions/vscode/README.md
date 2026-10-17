# Hoku for VS Code

A small companion extension for [Hoku](https://github.com/joao-afonso-p/hoku), the
local-first macOS app that maps your Claude Code, Codex and Claude Desktop sessions.

When a Claude Code session runs in a VS Code terminal, Hoku can't tell from the outside which
window or terminal tab it's in. With this extension installed, **Go to terminal** in Hoku
brings that exact VS Code window to the front and shows the terminal the session runs in.
Without it, Hoku falls back to just activating VS Code, and you pick the tab.

Hoku only says it switched to the session's terminal when the window confirms, for that
click, that it showed the terminal and came forward. Otherwise it activates VS Code and tells
you it couldn't select the window and terminal.

The extension is macOS only. On other systems it does nothing. It works with VS Code and VS
Code Insiders.

## Install

Install it from Hoku. Hoku ships the extension inside the app
(`Hoku.app/Contents/Resources/vscode/hoku-vscode.vsix`) and offers to install it: click
**Install in VS Code** in its setup sheet, or under Claude Code in **Integrations**. Hoku runs
VS Code's own `code --install-extension` with that bundled copy, so nothing is downloaded. You
can also install the same file with **Extensions: Install from VSIX…** in VS Code.

The extension isn't published on the Visual Studio Marketplace or Open VSX.

If VS Code was open while you installed it, reload its windows.

VS Code installs extensions per profile. If you use several VS Code profiles, install the
extension in each profile whose terminals you want Hoku to reach.

## The one-time prompt

The first time Hoku asks VS Code to show a terminal, VS Code asks:

> Allow 'Hoku' extension to open this URI?

Choose **Open**, and tick **Do not ask me again** so VS Code doesn't ask on every click. The
setup sheet's **Allow Hoku in VS Code** step brings VS Code forward and makes this prompt
appear in the front window, so you don't miss it. Hoku never changes VS Code settings to skip
the prompt.

## What it shares, and where

Each VS Code window writes a small file into a private folder on this Mac:
`~/Library/Application Support/com.hoku.app/vscode-bridge/`. The folder is readable only by
you (folders 0700, files 0600). The file holds:

- the process numbers of the window's open terminals;
- a window number, so Hoku can target the right window;
- the VS Code and extension versions;
- timestamps.

It's removed when the window closes.

When you click **Go to terminal**, Hoku leaves a one-time request in the same folder and opens
a `vscode://joao-afonso-p.hoku-vscode/...` link. The extension checks the request, shows the
matching terminal, and writes back a short reply: the window number, a status word such as
*shown*, and timestamps. Requests and replies live only a few seconds; Hoku deletes them, and
cleans up anything older than a minute the next time it goes to a VS Code terminal, checks the
extension or runs the setup step. If you click again before VS Code answers, the newer click
wins and the older one is dropped.

Nothing leaves your Mac. Neither the extension nor Hoku makes network requests, and Hoku
doesn't keep any of this in its index.

## What it never reads

- Terminal content or output. It never types into a terminal or runs commands either.
- Terminal names, working folders, file names or workspace paths.
- Your VS Code settings. It doesn't change any of them.

## Limits

- Remote windows (SSH, dev containers, WSL, Codespaces) aren't supported. Their terminals run
  on another machine, so Hoku falls back to activating VS Code.
- VS Code forks (Cursor, VSCodium, Windsurf) aren't supported.
- Claude Code sessions that run in the Claude Code extension panel, rather than in a
  terminal, keep Hoku's usual fallback.
- If two copies of VS Code of the same kind run at once (for example one started with a
  custom `--user-data-dir`), Hoku can't tell which one to ask, so it doesn't guess.
- A session inside tmux in a VS Code terminal is still one Hoku can't switch to.
- With macOS set not to switch desktops on activation, Hoku can only check that *some* VS Code
  window is on the current desktop, not the session's own window.

## Uninstall

In VS Code, open the Extensions view, find **Hoku**, and choose **Uninstall** (in each
profile where you installed it). Each window removes its file when the extension stops; Hoku
cleans up anything left behind the next time it checks VS Code.

## License

MIT. See [LICENSE](LICENSE).
