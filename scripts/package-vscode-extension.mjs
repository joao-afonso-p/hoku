#!/usr/bin/env node
// Builds the Hoku VS Code extension (extensions/vscode) and packages it as
// src-tauri/resources/vscode/hoku-vscode.vsix, which the Tauri bundle copies into
// Hoku.app/Contents/Resources/vscode/. Runs as part of `beforeBuildCommand`.
//
//   pnpm vscode:package
//
// Offline: `vsce package --no-dependencies` doesn't touch the network or the Marketplace.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extensions", "vscode");
const outDir = join(extensionDir, "out");
const vsixDir = join(root, "src-tauri", "resources", "vscode");
const vsix = join(vsixDir, "hoku-vscode.vsix");
const bin = (name) => join(root, "node_modules", ".bin", name);
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

// A clean build, so nothing stale (such as a removed module) ends up in the VSIX.
rmSync(outDir, { recursive: true, force: true });
run(bin("tsc"), ["-p", join(extensionDir, "tsconfig.build.json")], root);

mkdirSync(vsixDir, { recursive: true });
rmSync(vsix, { force: true });
run(bin("vsce"), ["package", "--no-dependencies", "--out", vsix], extensionDir);

console.log(`Packaged ${vsix} (${statSync(vsix).size} bytes)`);
