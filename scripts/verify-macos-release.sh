#!/usr/bin/env bash
# Verify a Hoku release build. Read-only: it never modifies the target, never launches
# Hoku, and never reads Hoku's index or any provider data.
#
#   ./scripts/verify-macos-release.sh Hoku_0.1.0_aarch64.dmg
#   ./scripts/verify-macos-release.sh /Applications/Hoku.app
#   ./scripts/verify-macos-release.sh <app-or-dmg> --version 0.1.0
#   ./scripts/verify-macos-release.sh <app-or-dmg> --require-notarized [--team-id ABCDE12345]
#
# For Hoku.app: bundle id com.hoku.app, an intact signature over the whole bundle
# (`codesign --verify --deep --strict`), hardened runtime, the Apple Events entitlement,
# and no database files inside the bundle (user data lives in
# ~/Library/Application Support/com.hoku.app, never in the bundle).
# Releases are ad-hoc signed (no paid Apple Developer account), so Gatekeeper
# (`spctl --assess`) is expected to reject them until the user approves the first launch;
# that result is reported, not treated as a failure. A Developer ID signed app must also
# pass `spctl --assess` as notarized and `xcrun stapler validate`.
# For a .dmg: the image checksum (`hdiutil verify`), its signature if it has one, then all
# of the above for the Hoku.app inside (mounted read-only and detached afterwards).
set -euo pipefail

APP_NAME="Hoku"
BUNDLE_ID="com.hoku.app"

target=""
team_id=""
version=""
require_notarized=0
usage() { sed -n '2,20p' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --team-id) team_id="${2:?--team-id needs a value}"; shift 2 ;;
    --version) version="${2:?--version needs a value}"; shift 2 ;;
    --require-notarized) require_notarized=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$target" ] || { echo "Only one app or dmg can be verified at a time." >&2; exit 2; }
       target="$1"; shift ;;
  esac
done
[ -n "$target" ] || { usage; exit 2; }

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[32m ok\033[0m %s\n' "$*"; }
note() { printf '\033[36m --\033[0m %s\n' "$*"; }
warn() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$*"; else printf '\033[33m !!\033[0m %s\n' "$*" >&2; fi
}
fail() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$*"; else printf '\033[31m xx\033[0m %s\n' "$*" >&2; fi
  exit 1
}
# Detach the dmg mounted by check_dmg, keeping the script's real exit status.
MOUNT=""
on_exit() {
  local status=$?
  if [ -n "$MOUNT" ]; then
    hdiutil detach "$MOUNT" -quiet 2>/dev/null || hdiutil detach "$MOUNT" -force -quiet 2>/dev/null || true
    rmdir "$MOUNT" 2>/dev/null || true
  fi
  exit "$status"
}
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null || true; }

# Sets SIG_KIND to the kind of signature on $1 ("adhoc", "developer-id", "other" or
# "unsigned") and SIG_INFO to the `codesign --display` output.
SIG_INFO=""
SIG_KIND=""
read_signature() {
  if ! SIG_INFO="$(codesign --display --verbose=4 "$1" 2>&1)"; then
    SIG_KIND=unsigned
  elif grep -q '^Signature=adhoc' <<<"$SIG_INFO"; then
    SIG_KIND=adhoc
  elif grep -q '^Authority=Developer ID Application: ' <<<"$SIG_INFO"; then
    SIG_KIND=developer-id
  else
    SIG_KIND=other
  fi
}

# Developer ID only: secure timestamp, team, Gatekeeper says notarized, ticket stapled.
check_notarized() {
  local path="$1" out
  shift
  grep -q '^Timestamp=' <<<"$SIG_INFO" || fail "$path has no secure timestamp (required for notarization)."
  if [ -n "$team_id" ]; then
    grep -qx "TeamIdentifier=$team_id" <<<"$SIG_INFO" || fail "$path is not signed by the expected team."
  fi
  out="$(spctl "$@" "$path" 2>&1)" || { printf '%s\n' "$out"; fail "Gatekeeper rejected $path."; }
  printf '%s\n' "$out"
  if grep -q 'override=security disabled' <<<"$out"; then
    warn "Gatekeeper assessments are disabled on this machine; spctl could not confirm notarization."
  elif ! grep -q 'source=Notarized Developer ID' <<<"$out"; then
    fail "Gatekeeper accepted $path but not as 'Notarized Developer ID'."
  fi
  xcrun stapler validate "$path" || fail "No valid notarization ticket is stapled to $path."
  ok "Developer ID signature, notarized and stapled"
}

check_app() {
  local app="$1" id app_version data_files entitlements out
  [ -d "$app/Contents" ] || fail "$app is not an app bundle."
  say "Checking $app"

  id="$(plist CFBundleIdentifier "$app")"
  [ "$id" = "$BUNDLE_ID" ] || fail "Bundle id is '$id', expected $BUNDLE_ID."
  [ "$(plist CFBundleName "$app")" = "$APP_NAME" ] || fail "Bundle name is not $APP_NAME."
  [ -x "$app/Contents/MacOS/$APP_NAME" ] || fail "Bundle has no $APP_NAME executable."
  app_version="$(plist CFBundleShortVersionString "$app")"
  if [ -n "$version" ] && [ "$app_version" != "$version" ]; then
    fail "Bundle version is $app_version, expected $version."
  fi
  ok "$APP_NAME $app_version ($id)"

  data_files="$(find "$app" \( -iname '*.sqlite' -o -iname '*.sqlite-*' -o -iname '*.db' -o -iname '*.db-*' \) -print)"
  [ -z "$data_files" ] || fail "Database files found inside the bundle: $data_files"
  ok "no database files inside the bundle"

  codesign --verify --deep --strict --verbose=2 "$app" || fail "codesign --verify --deep --strict failed for $app."
  ok "codesign --verify --deep --strict: the whole bundle is sealed and intact"

  read_signature "$app"
  grep -E '^(Identifier|Signature|Authority|TeamIdentifier|Timestamp|CodeDirectory)' <<<"$SIG_INFO" || true
  grep -qx "Identifier=$BUNDLE_ID" <<<"$SIG_INFO" || fail "Code signing identifier is not $BUNDLE_ID."
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$SIG_INFO" \
    || fail "Hardened runtime is not enabled."
  ok "code signing identifier $BUNDLE_ID, hardened runtime"

  entitlements="$(codesign --display --entitlements - --xml "$app" 2>/dev/null || true)"
  if grep -q 'com.apple.security.get-task-allow' <<<"$entitlements"; then
    fail "The debugging entitlement get-task-allow is present; this is not a release signature."
  fi
  grep -q 'com.apple.security.automation.apple-events' <<<"$entitlements" \
    || fail "The Apple Events entitlement is missing; opening sessions in iTerm/Terminal would fail."
  ok "Apple Events entitlement present, no debugging entitlements"

  case "$SIG_KIND" in
    developer-id) check_notarized "$app" --assess --type execute --verbose ;;
    adhoc)
      [ "$require_notarized" = 0 ] || fail "$app is ad-hoc signed, not notarized."
      ok "ad-hoc signature (free distribution, not notarized)"
      # Informational: Gatekeeper rejects ad-hoc apps until the user clicks Open Anyway
      # once, or the app was installed without quarantine (scripts/install.sh).
      out="$(spctl --assess --type execute --verbose "$app" 2>&1 || true)"
      note "spctl --assess --type execute: $(tr '\n' ' ' <<<"$out")"
      note "expected for an ad-hoc build; see docs/releasing.md (First launch)"
      ;;
    *) fail "$app has an unexpected signature (neither ad-hoc nor Developer ID Application)." ;;
  esac
}

check_dmg() {
  local dmg="$1" mount
  say "Checking $dmg"
  hdiutil verify -quiet "$dmg" || fail "The image checksum of $dmg doesn't verify; the file is damaged."
  ok "hdiutil verify: image checksum intact"

  read_signature "$dmg"
  case "$SIG_KIND" in
    unsigned)
      [ "$require_notarized" = 0 ] || fail "$dmg is not signed."
      note "the dmg itself is unsigned (normal for ad-hoc releases); the app inside is checked below"
      ;;
    developer-id)
      codesign --verify --strict --verbose=2 "$dmg" || fail "codesign --verify --strict failed for $dmg."
      check_notarized "$dmg" --assess --type open --context context:primary-signature --verbose
      ;;
    *)
      [ "$require_notarized" = 0 ] || fail "$dmg is not Developer ID signed."
      codesign --verify --strict --verbose=2 "$dmg" || fail "codesign --verify --strict failed for $dmg."
      ok "dmg signature intact ($SIG_KIND)"
      ;;
  esac

  mount="$(mktemp -d "${TMPDIR:-/tmp}/hoku-verify.XXXXXX")"
  MOUNT="$mount"
  trap on_exit EXIT
  hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mount" -quiet \
    || fail "Couldn't mount $dmg."
  [ -d "$mount/$APP_NAME.app" ] || fail "The dmg has no $APP_NAME.app at its root."
  [ -L "$mount/Applications" ] || warn "The dmg has no Applications shortcut for drag-to-install."
  check_app "$mount/$APP_NAME.app"
}

case "$target" in
  *.dmg) [ -f "$target" ] || fail "No such file: $target"; check_dmg "$target" ;;
  *.app | *.app/) check_app "${target%/}" ;;
  *) fail "Expected a .app bundle or a .dmg, got: $target" ;;
esac

printf '\n\033[32m✓\033[0m %s passed all release checks\n' "$target"
