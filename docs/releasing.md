# Releasing Hoku for macOS

Hoku ships as a `.dmg` on the repository's
[GitHub Releases](https://github.com/joao-afonso-p/hoku/releases). Users install it once
into `/Applications` and it stays there as a regular app. Releases are built by GitHub
Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) and cost
nothing: no Apple Developer Program membership, no certificates, no secrets.

- [How users install Hoku](#how-users-install-hoku)
- [What "ad-hoc signed, not notarized" means](#what-ad-hoc-signed-not-notarized-means)
- [User data and upgrades](#user-data-and-upgrades)
- [How the release workflow works](#how-the-release-workflow-works)
- [One-time repository setup](#one-time-repository-setup)
- [Cutting a release](#cutting-a-release)
- [Verifying a build](#verifying-a-build)
- [Clean-machine installation test](#clean-machine-installation-test)
- [Decisions](#decisions)

## How users install Hoku

**From Terminal (recommended).** One command installs or updates Hoku:

```bash
curl -fsSL https://raw.githubusercontent.com/joao-afonso-p/hoku/main/scripts/install.sh | bash
```

[`scripts/install.sh`](../scripts/install.sh) does the following:

1. Downloads the latest release's DMG and `SHA256SUMS.txt` and checks the SHA-256.
2. Mounts the DMG read-only and checks the app inside: bundle id `com.hoku.app`, intact
   code signature.
3. Quits a running Hoku cleanly.
4. Swaps `/Applications/Hoku.app` in place, putting the old copy back if the swap fails.
5. Launches Hoku.

It never touches `~/Library/Application Support/com.hoku.app`, and it compares the
index's project and session counts before and after to prove it.

Options: `--version v0.2.0` installs a specific release, `--dmg FILE` installs a DMG
you already downloaded (checked against a `SHA256SUMS.txt` next to it), `--dir
~/Applications` installs for your user only, and `--no-open` skips the launch. With
`curl | bash`, pass options after `bash -s --`.

**By hand.** Download `Hoku_<version>_aarch64.dmg` from the release page, open it, and
drag Hoku onto Applications. The first time you open it:

1. macOS says *"Apple could not verify 'Hoku' is free of malware…"*. Click **Done**
   (not *Move to Trash*).
2. Open **System Settings → Privacy & Security**, scroll to *Security*, and click
   **Open Anyway** next to *"Hoku" was blocked…*. Confirm with your password or Touch ID.
3. Hoku opens. From now on it opens normally, from Launchpad, Spotlight or the Dock.

You do this once per downloaded version. The installer script skips it, because it
installs without the quarantine flag (see below).

## What "ad-hoc signed, not notarized" means

Apple only trusts downloaded apps without a prompt if they're signed with a Developer
ID certificate and notarized, which requires the paid Apple Developer Program. Hoku
doesn't use it. Instead:

- **Ad-hoc signed.** The workflow signs the whole bundle with Tauri's ad-hoc identity
  (`APPLE_SIGNING_IDENTITY=-`), with hardened runtime and
  [`src-tauri/Entitlements.plist`](../src-tauri/Entitlements.plist). This matters: Tauri's
  default output only has a linker signature on the executable. `codesign --verify`
  rejects that ("code has no resources but signature indicates they must be present"),
  and a downloaded copy would be reported as **"damaged"** with no way to open it. With
  the whole bundle sealed, macOS enforces the signature and shows the one-time
  *Open Anyway* flow instead.
- **Not notarized.** Gatekeeper (`spctl --assess`) rejects the app until the user
  approves it once. Browser downloads carry a quarantine flag that triggers this check.
  `curl` doesn't set that flag, and the installer copies with `ditto --noqtn`, so
  script installs aren't prompted. That's reasonable only because the installer checks
  the SHA-256 first. It's the same as a user running
  `xattr -dr com.apple.quarantine /Applications/Hoku.app` after checking the download.
- **What vouches for a download instead.**
  - `SHA256SUMS.txt` detects corrupted or swapped files.
  - A **GitHub build provenance attestation** shows the DMG was built by this
    repository's release workflow from a specific commit:
    `gh attestation verify Hoku_<version>_aarch64.dmg --repo joao-afonso-p/hoku`.

  Neither replaces Apple's malware scan. The trust rests on the repository itself.
- **Apple Events.** Hardened runtime blocks Apple Events unless the app has the
  `com.apple.security.automation.apple-events` entitlement. Hoku uses Apple Events,
  through `osascript`, to switch to or open sessions in iTerm/Terminal. The entitlement
  and an `NSAppleEventsUsageDescription` (in [`src-tauri/Info.plist`](../src-tauri/Info.plist))
  make macOS show its normal "Hoku wants to control iTerm" prompt instead of failing
  silently.

## User data and upgrades

- The bundle identifier is **`com.hoku.app`**. Never change it: it names the data
  folder, and a different id would start with an empty index. The workflow, the
  verification script and the installer all refuse a bundle with another id.
- The index is `~/Library/Application Support/com.hoku.app/hub.sqlite`, which Tauri's
  `app_data_dir()` derives from the bundle id (`src-tauri/src/lib.rs`). It's **outside
  the app bundle**, and the verification script fails if any `*.sqlite`/`*.db` file is
  inside the bundle.
- Hoku isn't sandboxed, so that path doesn't depend on the signature. Unsigned local
  builds, ad-hoc releases and any future Developer ID build all share the same data
  folder.
- Updating replaces only `Hoku.app`, whether through the installer or by dragging and
  choosing *Replace*. On first launch, `db::open` applies pending migrations from the
  ordered `MIGRATIONS` list (tracked by `PRAGMA user_version`). Migrations must keep
  existing rows (`migrates_a_v1_database_without_losing_rows`).
- **Expected after each update:** macOS may ask again for permission to control
  iTerm/Terminal. An ad-hoc signature has no stable developer identity, so macOS treats
  each version as a new app for Automation permissions. The old entry can be removed in
  System Settings → Privacy & Security → Automation.

## How the release workflow works

| Trigger | Result |
|---|---|
| Push a tag `vX.Y.Z` | `Hoku_X.Y.Z_aarch64.dmg` + `SHA256SUMS.txt` + provenance attestation, attached to a **draft** GitHub Release for that tag |
| *Run workflow* from a branch | Rehearsal: the same DMG and checksums as a workflow artifact (kept 14 days). No release. |
| *Run workflow* from a tag | Same as pushing the tag (use it to retry a failed release) |

The workflow never publishes anything. A maintainer publishes the draft by hand after
the [clean-machine test](#clean-machine-installation-test). It refuses to replace the
assets of a release that's already been published.

It has three jobs:

1. **verify**: checks that `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` have the same version. On a tag, it also checks that the tag is
   `v<version>` and points to a commit on `main`. Then it runs `pnpm typecheck`,
   `pnpm test`, `cargo fmt --check` and `cargo test --locked`.
2. **build**:
   1. `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg --ci` with
      `APPLE_SIGNING_IDENTITY=-` (ad-hoc signing, set only in the workflow, so local
      builds are unaffected).
   2. [`scripts/verify-macos-release.sh`](../scripts/verify-macos-release.sh) on the app
      and on the DMG.
   3. `SHA256SUMS.txt`, uploaded with the DMG as a workflow artifact.
3. **release** (tags only): checks the checksums, attests the DMG's build provenance, and
   creates or updates the draft release with install instructions prepended to
   GitHub's generated notes. Tags with a pre-release suffix (`v0.2.0-beta.1`) become
   pre-releases. It's the only job with write permissions (`contents`, plus the
   `id-token`/`attestations` permissions the attestation needs).

The workflow uses no secrets. Third-party actions are pinned to commit SHAs, and
there are no build caches. `ci.yml` is unchanged.

**Never touched by the workflow.** It runs on a fresh GitHub-hosted runner. It never
launches Hoku and never runs the `#[ignore]`d probes (`probe_this_mac`,
`probe_window_space`). No step reads or writes `~/.claude`, `~/.codex`, Claude Desktop's
folders, provider credentials, or a Hoku index, and the runner has none of them.
`cargo test` uses tempdir fixtures only.

## One-time repository setup

Nothing is required: the workflow runs with the default `GITHUB_TOKEN`. Recommended:

- A **tag ruleset** (*Settings → Rules → Rulesets → New tag ruleset*, target `v*`) that
  restricts who can create, update and delete release tags.
- Keep *Settings → Actions → General → Workflow permissions* at the default read-only.
  The release job requests the write permissions it needs itself.

## Cutting a release

Versions follow [SemVer](https://semver.org). The version lives in three files that must
match: `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. The
release tag is `v` plus that version. The workflow enforces both.

```bash
# 1. Bump the version on a branch and merge it through a pull request.
git switch main && git pull --ff-only
git switch -c release/v0.2.0
#    edit "version" in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml
(cd src-tauri && cargo check)          # refreshes Cargo.lock for the new version
pnpm typecheck && pnpm test && pnpm build
(cd src-tauri && cargo fmt --check && cargo test)
git commit -am "chore: release v0.2.0"
git push -u origin release/v0.2.0      # then open a PR, wait for CI, merge

# 2. Tag the merged commit on main and push only the tag.
git switch main && git pull --ff-only
git tag -a v0.2.0 -m "Hoku 0.2.0"
git push origin v0.2.0

# 3. Watch the release run.
gh run watch

# 4. Check the draft: download, verify, test on a clean machine.
gh release download v0.2.0 --dir ./hoku-v0.2.0
(cd hoku-v0.2.0 && shasum -a 256 -c SHA256SUMS.txt)
gh attestation verify hoku-v0.2.0/Hoku_0.2.0_aarch64.dmg --repo joao-afonso-p/hoku
./scripts/verify-macos-release.sh hoku-v0.2.0/Hoku_0.2.0_aarch64.dmg --version 0.2.0

# 5. Publish when the clean-machine test passes. The installer's default
#    (releases/latest) only sees published, non-pre-release versions.
gh release edit v0.2.0 --draft=false
```

**First release, v0.1.0.** All three files already say `0.1.0`, so skip step 1. After
this workflow is merged, rehearse once (`gh workflow run release.yml --ref main`, then
`gh run download <run-id>`), then tag `v0.1.0` on `main`.

If a run fails, fix the cause and use *Re-run failed jobs*, or *Run workflow* from the
tag. The draft is updated in place. If the fix needs a code change, delete the draft and
the tag (`gh release delete v0.2.0 --cleanup-tag`) and tag the new commit. Once a
release is published, never move or reuse its tag: release a new patch version instead.

## Verifying a build

[`scripts/verify-macos-release.sh`](../scripts/verify-macos-release.sh) is read-only. It
takes a `.app` or a `.dmg`, and the workflow runs it on both. A DMG is checked with
`hdiutil verify`, mounted read-only, and detached afterwards.

```bash
./scripts/verify-macos-release.sh Hoku_0.2.0_aarch64.dmg --version 0.2.0
./scripts/verify-macos-release.sh /Applications/Hoku.app
```

It checks:

- bundle id and code signing identifier `com.hoku.app`
- no database files inside the bundle
- `codesign --verify --deep --strict --verbose Hoku.app`, which proves the whole bundle is
  sealed and unmodified
- hardened runtime, the Apple Events entitlement, and no `get-task-allow`
- ad-hoc signature (the expected kind for these releases)

It also runs `spctl --assess --type execute --verbose Hoku.app` and prints the result.
For ad-hoc releases the result is *rejected*, which is expected and not a failure.

`xcrun stapler validate Hoku.app` only applies to notarized builds. If the script is
given a Developer ID signed build, it requires `spctl` to report
`source=Notarized Developer ID` and `stapler validate` to pass. `--require-notarized`
makes it fail on anything else.

## Clean-machine installation test

Do this for every release before publishing the draft. Use a Mac that has never had
Hoku installed, or a **separate macOS user account** (*System Settings → Users &
Groups*). A separate account has its own `~/Library`, so your real index and provider
data are never involved. While the release is still a draft, only a logged-in
maintainer can download it, so use the browser for the manual path and
`gh release download` + `--dmg` for the script path.

**Manual install (what most users do)**

1. Download the DMG and `SHA256SUMS.txt` from the draft release page in **Safari**, so
   the file is quarantined like a real user's download. Run
   `shasum -a 256 -c SHA256SUMS.txt`.
2. Open the DMG, drag Hoku to Applications, eject the DMG, and open Hoku from
   Applications.
3. Expect the *"could not verify"* dialog. Go through **Privacy & Security → Open
   Anyway** and check that Hoku opens. It must never say *"damaged"*.
4. Quit and reopen it from Launchpad or Spotlight: no prompt this time.
5. Check the data location: `ls ~/Library/Application\ Support/com.hoku.app/` shows
   `hub.sqlite`, and `find /Applications/Hoku.app -name '*.sqlite*'` prints nothing.
6. Smoke test with **demo data** (Settings → Load demo): the Galaxy, ⌘K search and
   Settings work. If the account has a Claude Code session, *Go to terminal* shows the
   macOS Automation prompt for iTerm/Terminal once, then switches to or opens the
   session. This confirms the Apple Events entitlement.

**Script install and upgrade (preserves the index)**

1. In a second clean account, or after removing the manual install, run
   `./scripts/install.sh --dmg <downloaded dmg>` (with `SHA256SUMS.txt` next to it).
   Hoku opens with no Gatekeeper prompt.
2. Add some state: load demo data, create a project, favorite a session. Record the
   counts:
   `sqlite3 -readonly ~/Library/Application\ Support/com.hoku.app/hub.sqlite "select (select count(*) from projects), (select count(*) from sessions);"`
3. Install the new version over it (`--dmg` with the new DMG, or by dragging and
   choosing *Replace*). The installer quits Hoku, swaps the app, relaunches it, and
   reports the counts as unchanged. Check *Hoku → About Hoku* shows the new version and
   that your projects, favorites and positions are still there.

For v0.1.0 there's no earlier release. Do the upgrade step with a rehearsal artifact
over the draft build, or with the draft over a local build of the previous commit.

Don't run `pnpm install:local` in your main account to test a release: it replaces your
real `/Applications/Hoku.app` with a local build.

## Decisions

- **Free distribution: ad-hoc signed, not notarized** (see above). If you ever join the
  Apple Developer Program, the upgrade path is:
  - store a Developer ID Application certificate and an App Store Connect API key as
    GitHub secrets
  - have the build import the certificate and set `APPLE_SIGNING_IDENTITY`, plus
    `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH`, so Tauri signs,
    notarizes and staples the app (see Tauri's
    [macOS signing guide](https://v2.tauri.app/distribute/sign/macos/))
  - notarize and staple the DMG with `xcrun notarytool` and `xcrun stapler`
  - run the verification script with `--require-notarized`

  The data folder and bundle id don't change.
- **Apple Silicon only** (`aarch64-apple-darwin`), which is what Hoku is developed and
  tested on. The installer refuses to run on Intel Macs and points to building from
  source. A universal build would need `--target universal-apple-darwin`, the
  `x86_64-apple-darwin` Rust target, the `_universal` DMG name in the workflow and
  installer, and testing on an Intel Mac.
- **Minimum macOS version.** Not pinned (`bundle.macOS.minimumSystemVersion` unset).
  Apple Silicon implies macOS 11 or later. Pin it once an older version has been
  tested.
- **Installer URL.** The one-liner fetches `scripts/install.sh` from `main`, so changes
  to it take effect when merged. Review changes to it as carefully as the release
  workflow.
- **Updates.** No automatic updates (Tauri updater). Users rerun the installer or
  download the new DMG.
