#!/usr/bin/env node
// Captures the documentation screenshots from the real Hoku app, with made-up data only.
//
// It runs a debug build of Hoku with HOME pointed at a fresh temporary folder, so Hoku's
// index and every provider folder it reads (~/.claude, ~/.codex, Claude Desktop) live inside
// that folder. Your real index, sessions and sign-ins are never read. PATH is reduced to the
// system folders plus a stand-in `claude` script that only reports a version, so Hoku never
// runs your real Claude Code CLI (whose `auth status` would print your account).
//
// Two runs:
//   A  made-up Claude Code transcripts and a Codex thread index: first run, scan, inspector,
//      Forget, Add session.
//   B  Hoku's built-in demo data (Settings → Load demo): everything else.
//
// Screens are captured with the debug build's control socket (src-tauri/src/devtools.rs),
// which snapshots the webview without Screen Recording permission. Native macOS UI
// (notifications, the Dock, permission prompts) can't be captured this way.
//
// Usage (from site/):
//   (cd .. && pnpm tauri build --debug --no-bundle)   # once, builds src-tauri/target/debug/Hoku
//   pnpm capture                                     # writes ../docs/images/*.png
//   pnpm capture -- --only galaxy,forget --keep      # some shots; keep the temp folder
//
// Review every image before committing it.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const APP = path.resolve(opt("--app") ?? path.join(repo, "src-tauri/target/debug/Hoku"));
const OUT = path.resolve(opt("--out") ?? path.join(repo, "docs/images"));
const ONLY = opt("--only")?.split(",");
const KEEP = args.includes("--keep");
const WIDTH = 1800; // saved width in pixels; snapshots are taken at the display's scale
const PORT = 47831;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (name) => !ONLY || ONLY.includes(name);

// ───────────── control socket ─────────────

function send(message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1");
    let reply = "";
    socket.setTimeout(15000, () => socket.destroy(new Error("control socket timed out")));
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (d) => (reply += d));
    socket.on("end", () => (reply.startsWith("error:") ? reject(new Error(reply)) : resolve(reply)));
    socket.on("error", reject);
  });
}

function portInUse() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1");
    socket.on("connect", () => (socket.destroy(), resolve(true)));
    socket.on("error", () => resolve(false));
  });
}

/** Evaluate JS in the webview. Errors surface through the report channel. */
async function js(code) {
  const wrapped = `(async()=>{try{${code};await window.__TAURI_INTERNALS__.invoke("dev_report",{value:"ok"})}catch(e){await window.__TAURI_INTERNALS__.invoke("dev_report",{value:"error: "+e.message})}})()`;
  await send({ cmd: "eval", js: wrapped });
  for (let i = 0; i < 40; i++) {
    await sleep(50);
    const r = await send({ cmd: "report" });
    if (r === "ok") break;
    if (r.startsWith("error: ")) throw new Error(`in the app: ${r.slice(7)}\n  while running: ${code}`);
  }
  await send({ cmd: "eval", js: `window.__TAURI_INTERNALS__.invoke("dev_report",{value:""})` });
}

async function report(expr) {
  await send({ cmd: "eval", js: `Promise.resolve(${expr}).then(v=>window.__TAURI_INTERNALS__.invoke("dev_report",{value:String(v)}))` });
  for (let i = 0; i < 40; i++) {
    await sleep(50);
    const r = await send({ cmd: "report" });
    if (r) return r;
  }
  throw new Error(`no answer for ${expr}`);
}

// Small helpers installed in the page: find and press controls the way a user would.
const HELPERS = `window.__c={
  find:(t)=>[...document.querySelectorAll("button,[role=menuitem]")].find(b=>b.textContent.trim()===t||b.getAttribute("aria-label")===t||(b.title||"").startsWith(t)),
  btn:(t)=>{const b=__c.find(t);if(!b)throw new Error("no button: "+t);b.click();},
  type:(sel,v)=>{const el=document.querySelector(sel);if(!el)throw new Error("no field: "+sel);el.focus();const p=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}));},
  row:(has)=>{const rows=[...document.querySelectorAll("aside.slide-in-left .group")];const r=rows.find(x=>x.textContent.includes(has))??rows[0];if(!r)throw new Error("no rows");(r.querySelector("button.text-left")??r).click();},
  key:(k,o={},sel)=>{const t=sel?document.querySelector(sel):window;t.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true,cancelable:true,...o}));},
}`;

const PALETTE = 'input[placeholder^="Search sessions"]';

async function snap(name) {
  if (!want(name)) return;
  const file = path.join(OUT, `${name}.png`);
  await send({ cmd: "snapshot", path: file });
  execFileSync("/usr/bin/sips", ["--resampleWidth", String(WIDTH), file], { stdio: "ignore" });
  console.log(`  ✓ ${path.relative(repo, file)}`);
}

/** Back out of everything: overlays, selection, drawers, views, focus, filters. */
async function reset() {
  for (let i = 0; i < 7; i++) await js(`__c.key("Escape")`);
  await js(`__c.key("0",{metaKey:true})`);
  await sleep(900);
}

/** Search in ⌘K and act on the first hit (Enter, or ⌘Enter to show it on the map). */
async function palette(query, keys = {}) {
  await js(`__c.key("k",{metaKey:true})`);
  await sleep(300);
  await js(`__c.type(${JSON.stringify(PALETTE)},${JSON.stringify(query)})`);
  await sleep(400);
  await js(`__c.key("Enter",${JSON.stringify(keys)},${JSON.stringify(PALETTE)})`);
  await sleep(1600);
}

// ───────────── sandbox ─────────────

function sandbox(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `hoku-capture-${label}-`));
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  mkdirSync(path.join(root, "tmp"));
  const stub = path.join(home, ".local/bin/claude");
  writeFileSync(
    stub,
    `#!/bin/sh
# Stand-in for the Claude Code CLI while capturing screenshots.
case "$1" in
  --version) echo "2.1.281 (Claude Code)";;
  auth) echo '{"loggedIn": false}'; exit 1;;
  *) exit 1;;
esac
`,
  );
  chmodSync(stub, 0o755);
  // An empty live-session registry: sessions read as offline rather than unknown.
  mkdirSync(path.join(home, ".claude/sessions"), { recursive: true });
  return { root, home };
}

/**
 * Made-up provider data. Working directories are under /Users/me, which doesn't exist:
 * Hoku falls back to the recorded folder, and the UI shows it as ~/Code/…
 */
function writeFixtures(home) {
  const now = Date.now();
  const iso = (ago) => new Date(now - ago * 1000).toISOString();
  const transcripts = [
    ["atlas", "e01", "Add CSV import", "Add a CSV importer to the admin page", "feat/csv-import", 3600],
    ["atlas", "e02", "Fix flaky login test", "The login e2e test fails one run in five", "fix/login-flake", 7200],
    ["atlas", "e03", "Upgrade the ORM", "Upgrade the ORM to the next major version", "chore/orm", 86400],
    ["field-app", "e04", "Offline mode", "Make the field app work offline", "feat/offline", 5400],
    ["docs-site", "e05", "Restructure the guides", "Reorganize the guides section", "main", 172800],
  ];
  for (const [dir, n, title, prompt, branch, ago] of transcripts) {
    const cwd = `/Users/me/Code/${dir}`;
    const id = `1b6f0e2a-4c1d-4e8a-9f10-2a3b4c5d6${n}`;
    const folder = path.join(home, ".claude/projects", cwd.replace(/[/.]/g, "-"));
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${id}.jsonl`);
    const lines = [
      { type: "user", sessionId: id, cwd, gitBranch: branch, timestamp: iso(ago), version: "2.1.281", message: { role: "user", content: prompt } },
      { type: "ai-title", sessionId: id, aiTitle: title },
      { type: "assistant", sessionId: id, cwd, timestamp: iso(ago - 60), message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = new Date(now - (ago - 60) * 1000);
    utimesSync(file, t, t);
  }
  mkdirSync(path.join(home, ".codex"));
  const ms = now;
  const sql = `
CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER NOT NULL,
  source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  git_branch TEXT, git_origin_url TEXT, name TEXT, thread_source TEXT, updated_at_ms INTEGER,
  first_user_message TEXT NOT NULL DEFAULT '', is_pinned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER);
CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
INSERT INTO threads VALUES ('0192a3e5-5b7c-7d10-8e2f-000000000001','',0,0,'vscode','/Users/me/Code/field-app','Sync conflicts',0,'feat/sync',NULL,'Resolve sync conflicts','user',${ms - 1800000},'Resolve sync conflicts when two devices edit a form',0);
INSERT INTO threads VALUES ('0192a3e5-5b7c-7d10-8e2f-000000000002','',0,0,'vscode','/Users/me/Code/field-app','Map tiles',0,'main',NULL,'Cache map tiles','user',${ms - 90000000},'Cache map tiles for offline use',0);
INSERT INTO projects VALUES ('p1','Field App','{}',0);
INSERT INTO project_roots VALUES ('p1',0,'/Users/me/Code/field-app');`;
  execFileSync("/usr/bin/sqlite3", [path.join(home, ".codex/state_5.sqlite")], { input: sql });
}

async function launch(box) {
  if (await portInUse()) {
    throw new Error(`Port ${PORT} is in use: another debug build of Hoku (maybe \`pnpm tauri dev\` with your real data) is running. Quit it first.`);
  }
  const child = spawn(APP, [], {
    cwd: box.root,
    env: { HOME: box.home, PATH: `${box.home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: path.join(box.root, "tmp"), USER: "me", LANG: "en_US.UTF-8" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100 && !(await portInUse()); i++) await sleep(200);
  await sleep(2500); // first load and the first runtime pass
  await send({ cmd: "eval", js: HELPERS });
  // Safety check: the app answering must be the one using this sandbox.
  const db = await report(`window.__TAURI_INTERNALS__.invoke("database_path")`);
  if (!db.startsWith(box.home)) {
    child.kill();
    throw new Error(`The app on port ${PORT} uses ${db}, not the sandbox. Stopping.`);
  }
  return child;
}

async function stop(child) {
  child.kill("SIGTERM");
  for (let i = 0; i < 25 && (await portInUse()); i++) await sleep(200);
}

// ───────────── scenes ─────────────

async function runA() {
  console.log("Run A: made-up provider data");
  const box = sandbox("a");
  writeFixtures(box.home);
  const app = await launch(box);
  try {
    await snap("first-run");
    await js(`__c.btn("Scan this Mac")`);
    await sleep(3500);
    await snap("scan");
    await js(`__c.btn("Create 2 projects")`);
    await sleep(4500); // let the toast fade
    await palette("csv import", { metaKey: true });
    await sleep(4500); // one runtime pass after the scan
    await js(`__c.type('textarea[placeholder^="Why this session"]',"Importer works for small files. Next: stream large CSVs instead of loading them in memory.");document.activeElement.blur()`);
    await sleep(1200);
    await snap("inspector");
    await js(`__c.btn("Remove from Hoku")`);
    await sleep(800);
    await snap("forget");
    await reset();
    await js(`__c.key("n",{metaKey:true})`);
    await sleep(600);
    await js(`__c.btn("Claude")`);
    await js(`__c.type('input[placeholder^="https://claude.ai"]',"https://claude.ai/chat/3f2b8c1e-7d4a-4e9b-a6c5-1d2e3f4a5b6c")`);
    await js(`__c.type('input[placeholder^="What is this conversation"]',"Pricing page copy review")`);
    await sleep(900);
    await snap("add-session");
  } finally {
    await stop(app);
    if (!KEEP) rmSync(box.root, { recursive: true, force: true });
    else console.log(`  kept ${box.root}`);
  }
}

async function runB() {
  console.log("Run B: demo data");
  const box = sandbox("b");
  const app = await launch(box);
  try {
    await js(`__c.btn("Settings")`);
    await sleep(500);
    await js(`__c.btn("Load demo")`);
    await sleep(800);
    await js(`__c.btn("Done")`);
    await sleep(4500);
    await reset();
    await snap("galaxy");

    await js(`__c.btn("Needs You")`);
    await sleep(900);
    await js(`__c.row("permission")`);
    await sleep(1800);
    await snap("needs-you");
    await reset();

    await js(`__c.btn("Follow up")`);
    await sleep(900);
    await js(`__c.row("Overdue")`);
    await sleep(1800);
    await snap("follow-up");
    await reset();

    await js(`__c.btn("Activity")`);
    await sleep(1500);
    await snap("activity");
    await reset();

    await js(`__c.key("k",{metaKey:true})`);
    await sleep(300);
    await js(`__c.type(${JSON.stringify(PALETTE)},"release")`);
    await sleep(700);
    await snap("command-palette");
    await reset();

    await js(`__c.btn("Projects")`);
    await sleep(700);
    await js(`__c.row("Vega")`);
    await sleep(1500);
    await js(`__c.key("r")`);
    await sleep(1500);
    await snap("resume");
    await reset();

    await js(`__c.btn("Sessions")`);
    await sleep(1200);
    await snap("sessions");
    await reset();

    await js(`__c.btn("Recaps")`);
    await sleep(1500);
    // Outcomes are always written by the user; the demo has none, so write three.
    for (const text of ["Shipped offline mode to the beta group", "Cut p95 search latency from 900 ms to 310 ms", "Decided on the billing webhook retry strategy"]) {
      await js(`__c.type('input[placeholder^="e.g. Shipped"]',${JSON.stringify(text)})`);
      await js(`__c.btn("Add")`);
      await sleep(600);
    }
    await js(`[...document.querySelectorAll('input[aria-label^="Show “"]')].slice(0,3).forEach(b=>b.click())`);
    await sleep(1200);
    await snap("recaps");
    await reset();

    await js(`__c.btn("Projects")`);
    await sleep(700);
    await js(`[...document.querySelectorAll('button[aria-label="Archive project"]')].pop().click()`);
    await sleep(4500);
    await js(`[...document.querySelectorAll("button")].find(b=>b.textContent.trim().startsWith("› Archived")||b.textContent.includes("Archived")&&b.getAttribute("aria-expanded")!==null).click()`);
    await sleep(800);
    await snap("projects");
  } finally {
    await stop(app);
    if (!KEEP) rmSync(box.root, { recursive: true, force: true });
    else console.log(`  kept ${box.root}`);
  }
}

if (!existsSync(APP)) {
  console.error(`No debug build at ${APP}.\nBuild it first: (cd .. && pnpm tauri build --debug --no-bundle)`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const A = ["first-run", "scan", "inspector", "forget", "add-session"];
const B = ["galaxy", "needs-you", "follow-up", "activity", "command-palette", "resume", "sessions", "recaps", "projects"];
try {
  if (!ONLY || ONLY.some((n) => A.includes(n))) await runA();
  if (!ONLY || ONLY.some((n) => B.includes(n))) await runB();
  console.log("Done. Review every image before committing it.");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
