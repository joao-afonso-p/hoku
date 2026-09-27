#!/usr/bin/env bash
# Install or update Hoku from GitHub Releases, as a regular app in /Applications.
#
#   curl -fsSL https://raw.githubusercontent.com/joao-afonso-p/hoku/main/scripts/install.sh | bash
#   curl -fsSL .../scripts/install.sh | bash -s -- --version v0.2.0   # a specific release
#   ./scripts/install.sh --dmg ~/Downloads/Hoku_0.2.0_aarch64.dmg    # a DMG you already have
#
# Options:
#   --version vX.Y.Z   release to install (default: the latest published release)
#   --dmg FILE         install this DMG; its SHA256SUMS.txt must sit next to it to be checked
#   --dir DIR          where to install (default: /Applications)
#   --no-open          don't launch Hoku afterwards
#
# It downloads the DMG and SHA256SUMS.txt with curl, checks the SHA-256, mounts the DMG
# read-only, checks the app inside (bundle id com.hoku.app, intact code signature), quits a
# running Hoku cleanly, swaps the app in place (putting the old one back if that fails),
# and launches it.
#
# Hoku releases are free and not notarized by Apple. The copy installed here carries no
# quarantine flag, so macOS doesn't show its "can't verify the developer" prompt; the
# checksum check is what stands in for it. macOS still enforces the code signature.
#
# Your data in ~/Library/Application Support/com.hoku.app is never touched: only the app
# bundle is replaced, and the index's project and session counts are compared before and
# after (read-only).
set -euo pipefail

# Everything runs inside main, so a partially downloaded script (curl | bash) does nothing.
main() {
  local repo="joao-afonso-p/hoku"
  local app_name="Hoku" bundle_id="com.hoku.app"
  local data="$HOME/Library/Application Support/com.hoku.app/hub.sqlite"
  local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

  local version="" dmg_file="" dir="/Applications" open_after=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) version="${2:?--version needs a value, for example v0.2.0}"; shift 2 ;;
      --dmg) dmg_file="${2:?--dmg needs a file}"; shift 2 ;;
      --dir) dir="${2:?--dir needs a folder}"; shift 2 ;;
      --no-open) open_after=0; shift ;;
      -h | --help) usage; return 0 ;;
      *) echo "Unknown option: $1" >&2; usage >&2; return 2 ;;
    esac
  done
  [ -z "$version" ] || [ -z "$dmg_file" ] || fail "Use either --version or --dmg, not both."
  dir="${dir%/}"

  # Preconditions. Under Rosetta `uname -m` says x86_64, so ask the hardware.
  [ "$(uname -s)" = Darwin ] || fail "Hoku runs on macOS only."
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] \
    || fail "Hoku releases are built for Apple Silicon. On an Intel Mac, build it from source (see the README)."
  local cmd
  for cmd in curl shasum hdiutil ditto codesign; do
    command -v "$cmd" >/dev/null || fail "$cmd is required but wasn't found."
  done
  [ -d "$dir" ] || fail "$dir doesn't exist."
  [ -w "$dir" ] || fail "Can't write to $dir. Use an administrator account, or install for yourself only with: --dir ~/Applications"

  work="$(mktemp -d "${TMPDIR:-/tmp}/hoku-install.XXXXXX")"
  mount="$work/mnt"
  trap on_exit EXIT

  # 1. Get the DMG and the expected checksum.
  local dmg expected="" sums name base
  if [ -n "$dmg_file" ]; then
    [ -f "$dmg_file" ] || fail "No such file: $dmg_file"
    dmg="$dmg_file"
    sums="$(dirname "$dmg_file")/SHA256SUMS.txt"
    if [ -f "$sums" ]; then
      expected="$(checksum_for "$(basename "$dmg_file")" "$sums")"
      [ -n "$expected" ] || fail "$sums has no entry for $(basename "$dmg_file")."
    else
      warn "No SHA256SUMS.txt next to $dmg_file, so its checksum can't be checked. Download SHA256SUMS.txt from the same release into that folder to check it."
    fi
  else
    if [ -n "$version" ]; then
      case "$version" in v*) ;; *) version="v$version" ;; esac
      base="https://github.com/$repo/releases/download/$version"
    else
      base="https://github.com/$repo/releases/latest/download"
    fi
    say "Downloading Hoku ${version:-(latest release)} from github.com/${repo}…"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$work/SHA256SUMS.txt" "$base/SHA256SUMS.txt" \
      || fail "Couldn't download SHA256SUMS.txt for ${version:-the latest release}. Check that the release exists and is published."
    name="$(awk '$2 ~ /^Hoku_[0-9A-Za-z.+-]+_aarch64\.dmg$/ { print $2; exit }' "$work/SHA256SUMS.txt")"
    [ -n "$name" ] || fail "The release's SHA256SUMS.txt lists no Apple Silicon DMG."
    expected="$(checksum_for "$name" "$work/SHA256SUMS.txt")"
    curl -fL --proto '=https' --tlsv1.2 --progress-bar -o "$work/$name" "$base/$name" \
      || fail "Couldn't download $name."
    dmg="$work/$name"
  fi

  # 2. Check it before touching anything installed.
  if [ -n "$expected" ]; then
    local actual
    actual="$(shasum -a 256 "$dmg" | awk '{ print $1 }')"
    [ "$actual" = "$expected" ] \
      || fail "Checksum mismatch for $(basename "$dmg") (expected $expected, got $actual). Nothing was installed."
    say "Checksum OK ($(basename "$dmg"))"
  fi
  mkdir "$mount"
  hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mount" -quiet || fail "Couldn't open $dmg."
  mounted=1
  local src="$mount/$app_name.app"
  [ -d "$src" ] || fail "The DMG has no $app_name.app."
  [ "$(plist CFBundleIdentifier "$src")" = "$bundle_id" ] || fail "The app in the DMG isn't $bundle_id. Not installing."
  codesign --verify --deep --strict "$src" 2>/dev/null || fail "The app's code signature is broken. Not installing."
  local new_version
  new_version="$(plist CFBundleShortVersionString "$src")"

  local dest="$dir/$app_name.app" old_version=""
  if [ -d "$dest" ]; then
    [ "$(plist CFBundleIdentifier "$dest")" = "$bundle_id" ] \
      || fail "$dest exists but isn't Hoku ($bundle_id). Not replacing it."
    old_version="$(plist CFBundleShortVersionString "$dest")"
    say "Updating Hoku ${old_version:-?} → $new_version in $dir"
  else
    say "Installing Hoku $new_version into $dir"
  fi

  local before
  before="$(index_counts "$data")"

  # 3. Quit the installed copy cleanly if it's running. Never force-kill.
  local was_running=0 _
  if [ -n "$(installed_pid "$dest" "$app_name")" ]; then
    was_running=1
    say "Quitting the running Hoku…"
    osascript -e "tell application \"$dest\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do [ -z "$(installed_pid "$dest" "$app_name")" ] && break; sleep 0.2; done
    [ -z "$(installed_pid "$dest" "$app_name")" ] || fail "Hoku didn't quit within 10 s. Quit it yourself and run this again."
  fi

  # 4. Copy next to the installed app, swap, then drop the old one. If the swap fails, the
  # previous install is put back. --noqtn: see the header.
  local tmp="$dir/.$app_name.app.installing" old="$dir/.$app_name.app.previous"
  rm -rf "$tmp" "$old"
  ditto --noqtn "$src" "$tmp" || { rm -rf "$tmp"; fail "Couldn't copy Hoku into $dir."; }
  codesign --verify --deep --strict "$tmp" 2>/dev/null || { rm -rf "$tmp"; fail "The copied app doesn't verify. Nothing was replaced."; }
  if [ -d "$dest" ]; then mv "$dest" "$old"; fi
  if ! mv "$tmp" "$dest"; then
    if [ -d "$old" ]; then mv "$old" "$dest"; fi
    fail "Couldn't move the new app into place; the previous install was restored."
  fi
  rm -rf "$old"
  "$lsregister" -f "$dest" >/dev/null 2>&1 || true

  # 5. The index must be exactly as it was.
  local after
  after="$(index_counts "$data")"
  [ "$after" = "$before" ] || fail "Hoku's index changed during the install ($before → $after). Please report this."

  # 6. Launch.
  if [ "$open_after" = 1 ] || [ "$was_running" = 1 ]; then
    say "Launching Hoku…"
    open "$dest"
  fi

  printf '\n\033[32m✓\033[0m Hoku %s installed at %s\n' "$new_version" "$dest"
  printf '  your index  %s, untouched\n' "$after"
  if [ -n "$old_version" ]; then
    printf '  macOS may ask again for permission to control iTerm or Terminal; that is expected after an update.\n'
  fi
}

usage() {
  cat <<'EOF'
Install or update Hoku from GitHub Releases.

  curl -fsSL https://raw.githubusercontent.com/joao-afonso-p/hoku/main/scripts/install.sh | bash
  ... | bash -s -- --version v0.2.0
  ./scripts/install.sh --dmg ~/Downloads/Hoku_0.2.0_aarch64.dmg

Options:
  --version vX.Y.Z   release to install (default: the latest published release)
  --dmg FILE         install this DMG (checked against a SHA256SUMS.txt next to it)
  --dir DIR          where to install (default: /Applications)
  --no-open          don't launch Hoku afterwards

Your data in ~/Library/Application Support/com.hoku.app is never touched.
EOF
}

work=""
mount=""
mounted=0
# Keeps the script's real exit status: otherwise a failure could exit 0 through the trap.
on_exit() {
  local status=$?
  cleanup
  exit "$status"
}
cleanup() {
  if [ "$mounted" = 1 ]; then
    hdiutil detach "$mount" -quiet 2>/dev/null || hdiutil detach "$mount" -force -quiet 2>/dev/null || true
  fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
}

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null || true; }

# The hash for file $1 in the `shasum -a 256` output file $2.
checksum_for() { awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$2"; }

# Read-only project/session counts of the index, to prove the install left it alone.
index_counts() {
  [ -f "$1" ] || { echo "none yet"; return; }
  command -v sqlite3 >/dev/null || { echo "not checked (no sqlite3)"; return; }
  sqlite3 -readonly "$1" "select (select count(*) from projects) || ' projects, ' || (select count(*) from sessions) || ' sessions'" 2>/dev/null || echo "unreadable"
}

# Only the copy at $1, never a dev build or another install.
installed_pid() { pgrep -f "^$1/Contents/MacOS/$2" || true; }

main "$@"
