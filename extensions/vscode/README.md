# Hoku for VS Code

A small companion extension for [Hoku](https://github.com/joao-afonso-p/hoku), the
local-first macOS app that maps your Claude Code and Codex sessions.

When a session runs in a VS Code terminal, Hoku can't tell from the outside which window or
terminal tab it's in. With this extension installed, clicking the session in Hoku brings that
exact VS Code window to the front and shows the terminal the session runs in. Without it,
Hoku falls back to just activating VS Code.

The extension is macOS only. On other systems it does nothing.

## Install

Install it from Hoku. Hoku ships the extension inside the app and offers to install it into
VS Code for you. It isn't published on the Marketplace.

The first time Hoku talks to VS Code, VS Code asks:

> Allow 'Hoku' extension to open this URI?

Choose **Open**. If you also tick **Do not ask me again**, VS Code won't ask on later
clicks.

VS Code installs extensions per profile. If you use several VS Code profiles, install the
extension in each profile whose terminals you want Hoku to reach.

## What it shares, and where

Each VS Code window writes a small file into a private folder on this Mac:
`~/Library/Application Support/com.hoku.app/vscode-bridge/`. The folder is readable only by
you (mode 0700, files 0600). The file holds:

- the process numbers of the window's open terminals;
- a window number, so Hoku can target the right window;
- the VS Code and extension versions;
- timestamps.

When you click a session, Hoku leaves a one-time request in the same folder and opens a
`vscode://joao-afonso-p.hoku-vscode/...` link. The extension checks the request, shows the
matching terminal, and writes back a short reply with the same kind of information.

Nothing leaves your Mac. The extension makes no network requests.

## What it never reads

- Terminal content or output. It never types into a terminal either.
- Terminal names, working folders, file names or workspace paths.
- Your VS Code settings. It doesn't change any of them.

## Limits

- Remote windows (SSH, containers, WSL, Codespaces) aren't supported. Their terminals run on
  another machine, so Hoku falls back to activating VS Code.
- Claude Code sessions that run in the Claude Code extension panel, rather than in a
  terminal, keep Hoku's usual fallback.

## Uninstall

In VS Code, open the Extensions view, find **Hoku**, and choose **Uninstall** (in each
profile where you installed it). Each window removes its file when the extension stops; Hoku
cleans up anything left behind.

## License

MIT. See [LICENSE](LICENSE).
