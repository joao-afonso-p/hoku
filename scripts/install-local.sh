#!/usr/bin/env bash
# Build Hoku and install/update /Applications/Hoku.app. Optional: `pnpm tauri dev` needs no
# install. Writing to /Applications may need admin rights; the index check uses `sqlite3`.
#
#   ./scripts/install-local.sh              build, install, (re)launch
#   ./scripts/install-local.sh --no-build   install an existing release build (e.g. from `pnpm tauri build`)
#   ./scripts/install-local.sh --no-open    don't launch afterwards
#
# User data lives in ~/Library/Application Support/com.hoku.app (the SQLite index), never
# inside the app bundle. This script only ever replaces the bundle; it never touches that
# folder, and it checks the index before and after to prove it.
#
# The build is *moved* into /Applications, not copied, and its build-folder path is
# unregistered from Launch Services: a leftover Hoku.app in target/ would otherwise show up
# as a second "Hoku" in Spotlight and Launchpad.
set -euo pipefail

APP_NAME="Hoku"
BUNDLE_ID="com.hoku.app"
DEST="/Applications/${APP_NAME}.app"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILT="$ROOT/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DATA="$HOME/Library/Application Support/${BUNDLE_ID}/hub.sqlite"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

build=1
open_after=1
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --no-open) open_after=0 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null || true; }
index_counts() {
  [ -f "$DATA" ] || { echo "none"; return; }
  sqlite3 -readonly "$DATA" "select (select count(*) from projects) || ' projects, ' || (select count(*) from sessions) || ' sessions'" 2>/dev/null || echo "unreadable"
}
# Only the installed copy — never the dev build (target/debug) or a release run from target/.
installed_pid() { pgrep -f "^${DEST}/Contents/MacOS/${APP_NAME}" || true; }

before="$(index_counts)"
say "Index before: $before ($DATA)"

# 1. Build, and make sure it worked.
if [ "$build" = 1 ]; then
  say "Building the release version (this takes a minute or two)…"
  (cd "$ROOT" && pnpm tauri build) || fail "Build failed; /Applications/${APP_NAME}.app was not touched."
fi

# 2. Locate and sanity-check the bundle before touching anything installed.
[ -d "$BUILT" ] || fail "No build found at $BUILT (installs move it out). Run without --no-build."
[ "$(plist CFBundleIdentifier "$BUILT")" = "$BUNDLE_ID" ] || fail "Built bundle id is '$(plist CFBundleIdentifier "$BUILT")', expected $BUNDLE_ID. Not installing."
[ "$(plist CFBundleName "$BUILT")" = "$APP_NAME" ] || fail "Built bundle is named '$(plist CFBundleName "$BUILT")', expected $APP_NAME. Not installing."
[ -x "$BUILT/Contents/MacOS/$APP_NAME" ] || fail "Built bundle has no $APP_NAME executable."
version="$(plist CFBundleShortVersionString "$BUILT")"
say "Built ${APP_NAME} ${version} (${BUNDLE_ID})"

# 3. Quit the installed copy cleanly if it's running. Never force-kill.
was_running=0
if [ -n "$(installed_pid)" ]; then
  was_running=1
  say "Quitting the running ${DEST}…"
  osascript -e "tell application \"${DEST}\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do [ -z "$(installed_pid)" ] && break; sleep 0.2; done
  [ -z "$(installed_pid)" ] || fail "${APP_NAME} didn't quit within 10 s. Quit it yourself and run this again."
fi

# 4. Replace the bundle: move the build next to the installed one, swap, then drop the old
# one. If the swap fails, the previous install is put back. Moving (not copying) leaves no
# second Hoku.app behind in the build folder.
tmp="$(dirname "$DEST")/.${APP_NAME}.app.installing"
old="$(dirname "$DEST")/.${APP_NAME}.app.previous"
rm -rf "$tmp" "$old"
say "Installing to ${DEST}…"
"$LSREGISTER" -u "$BUILT" >/dev/null 2>&1 || true
if ! mv "$BUILT" "$tmp" 2>/dev/null; then
  # Different volume: copy, then remove the build copy.
  ditto "$BUILT" "$tmp" && rm -rf "$BUILT"
fi
if [ -d "$DEST" ]; then mv "$DEST" "$old"; fi
if ! mv "$tmp" "$DEST"; then
  [ -d "$old" ] && mv "$old" "$DEST"
  fail "Couldn't move the new build into place; the previous install was restored."
fi
rm -rf "$old"
# Let Launch Services (Dock, Finder, Spotlight) pick up the new name and icon.
"$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true

# 5. The index must be exactly as it was.
after="$(index_counts)"
[ "$after" = "$before" ] || fail "Index changed during install ($before → $after). Investigate before using Hoku."

# 6. Relaunch.
if [ "$open_after" = 1 ] || [ "$was_running" = 1 ]; then
  say "Launching ${DEST}…"
  open "$DEST"
fi

# 7. Report.
installed_version="$(plist CFBundleShortVersionString "$DEST")"
printf '\n\033[32m✓\033[0m %s %s installed at %s\n' "$APP_NAME" "$installed_version" "$DEST"
printf '  bundle id  %s\n' "$(plist CFBundleIdentifier "$DEST")"
printf '  index      %s — untouched (%s)\n' "$after" "$DATA"
