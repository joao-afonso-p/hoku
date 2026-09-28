#!/usr/bin/env node
// Decides what the Version workflow (.github/workflows/version.yml) does after a push to main.
//
//   tag   package.json has a version with no v<version> tag yet: a release PR was just merged
//         (or the version was bumped by hand). Tag this commit and build the release.
//   pr    releasable commits since the last v* tag: open or update the release PR with the
//         next version.
//   none  nothing to release.
//
// The next version follows Conventional Commits since the last tag: feat → minor, fix or perf
// → patch, a breaking change (`type!:` or `BREAKING CHANGE:`) → major, or minor while < 1.0.
// Other types (docs, ci, chore, test, refactor, style, build) don't release on their own.
//
// Prints key=value lines for $GITHUB_OUTPUT. Run it locally to preview: node scripts/next-version.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parse(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`Not a plain x.y.z version: ${version}`);
  return m.slice(1).map(Number);
}

export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** "major" | "minor" | "patch" | null, from commit messages (subject + body). */
export function bumpFor(messages) {
  let level = null;
  for (const message of messages) {
    const subject = message.split("\n", 1)[0];
    const m = /^(\w+)(\([^)]*\))?(!)?:\s/.exec(subject);
    if (!m) continue;
    const [, type, , bang] = m;
    if (type === "chore" && /^chore(\([^)]*\))?: release v/.test(subject)) continue;
    if (bang || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";
    if (type === "feat") level = "minor";
    else if ((type === "fix" || type === "perf") && level === null) level = "patch";
  }
  return level;
}

export function bump(version, level) {
  const [major, minor, patch] = parse(version);
  // Before 1.0, a breaking change bumps the minor version (SemVer §4).
  if (level === "major") return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The decision, from plain inputs, so it can be tested without git. */
export function plan({ current, tagged, lastTag, messages }) {
  if (!tagged && (lastTag === null || compare(current, lastTag) > 0)) return { mode: "tag", version: current };
  const level = bumpFor(messages);
  if (!level) return { mode: "none", version: current };
  const base = lastTag !== null && compare(lastTag, current) > 0 ? lastTag : current;
  return { mode: "pr", version: bump(base, level) };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const current = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version;
  let tagged = true;
  try {
    git("rev-parse", "-q", "--verify", `refs/tags/v${current}`);
  } catch {
    tagged = false;
  }
  let lastTag = null;
  try {
    lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD").replace(/^v/, "");
  } catch {
    // No release tag yet.
  }
  const range = lastTag ? [`v${lastTag}..HEAD`] : ["HEAD"];
  const log = git("log", ...range, "--format=%B%x1e");
  const messages = log.split("\x1e").map((m) => m.trim()).filter(Boolean);
  const result = plan({ current, tagged, lastTag, messages });
  console.log(`mode=${result.mode}`);
  console.log(`version=${result.version}`);
  console.log(`previous=${lastTag ?? ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
