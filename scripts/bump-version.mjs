#!/usr/bin/env node
// Sets Hoku's version everywhere it lives, in one step:
//   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the app's entry in
//   src-tauri/Cargo.lock.
// The release workflow refuses to build if they disagree, and `cargo test --locked` fails if
// Cargo.lock is behind Cargo.toml.
//
// Usage: node scripts/bump-version.mjs 0.3.0

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z>");
  process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));

/** Replace exactly one match, keeping the file's formatting. */
function edit(file, pattern, replacement) {
  const path = `${root}/${file}`;
  const before = readFileSync(path, "utf8");
  if (!pattern.test(before)) throw new Error(`${file}: version line not found`);
  const after = before.replace(pattern, replacement);
  writeFileSync(path, after);
  console.log(`${file}: ${version}`);
}

edit("package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
// The first `version = ` in Cargo.toml is the [package] one.
edit("src-tauri/Cargo.toml", /^(version = ")[^"]+(")/m, `$1${version}$2`);
const crate = /^name = "([^"]+)"/m.exec(readFileSync(`${root}/src-tauri/Cargo.toml`, "utf8"))[1];
edit("src-tauri/Cargo.lock", new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]+(")`), `$1${version}$2`);
