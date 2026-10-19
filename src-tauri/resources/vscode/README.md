# Bundled VS Code extension

`hoku-vscode.vsix` is generated here at build time by `pnpm vscode:package` (part of
Tauri's `beforeBuildCommand`) from `extensions/vscode/`. It isn't committed (`*.vsix` is
git-ignored). The Tauri bundle copies this folder to `Hoku.app/Contents/Resources/vscode/`.

This README is tracked so the folder, and the `resources/vscode/*` glob in
`tauri.conf.json`, always match something, even before the VSIX has been built.
