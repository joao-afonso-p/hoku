# Hoku user guide

The source of <https://joao-afonso-p.github.io/hoku/>: an [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build) static site. It's separate from the app. It has
its own `package.json` and lockfile, the root `pnpm install` doesn't install it, and nothing
here runs Tauri, Rust or the app's Vite build.

## Run it locally

Requirements: Node 22.12+ and pnpm 10.

```bash
cd site
pnpm install
pnpm dev        # http://localhost:4321/hoku/  (live reload; search works only in a build)
pnpm build      # astro check + astro build into site/dist, validating every internal link
pnpm preview    # serves site/dist at http://localhost:4321/hoku/, like GitHub Pages
```

## Where things are

| Path | What |
|---|---|
| `src/content/docs/` | The pages, in MDX. The folder structure is the URL structure. |
| `astro.config.mjs` | Site URL, the `/hoku` base path, sidebar, theme, plugins |
| `src/styles/custom.css` | Hoku's accent colors (contrast-checked) and screenshot styling |
| `../docs/images/` | Screenshots, shared with the README and contributor docs |
| `scripts/capture-screenshots.mjs` | Recaptures the screenshots from the real app (below) |

## Writing pages

- **Links:** always absolute and including the base, with a trailing slash:
  `[Install](/hoku/start/install/)`. The build fails on a broken link or anchor
  ([starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator)), and
  on relative links, which would break under `/hoku/`.
- **Images:** reference them from `docs/images/` with a relative path, such as
  `![…](../../../../../docs/images/galaxy.png)` from a page in a subfolder. Astro serves
  resized WebP versions. Every image needs alt text that says what the screenshot shows.
- **New pages** go in the `sidebar` in `astro.config.mjs`.
- **Style:** US English, second person, present tense, short sentences. Quote UI labels
  exactly, in bold, and show keys as `<kbd>⌘</kbd><kbd>K</kbd>`. Say what a feature
  doesn't do and where its limits are. No superlatives, and no claim the code doesn't back.

## Screenshots

Screenshots must be real captures of Hoku with made-up data. Never use mockups, and never
use your real sessions.

```bash
(cd .. && pnpm tauri build --debug --no-bundle)   # builds src-tauri/target/debug/Hoku
pnpm capture                                     # writes ../docs/images/*.png
pnpm capture -- --only galaxy,forget             # just some
```

The script runs the debug build with `HOME` pointed at a new temporary folder, so Hoku's
index and every provider folder it reads live there. Your real data is never read. It uses
Hoku's built-in demo data, plus made-up Claude Code and Codex files for the scan screens.
PATH is reduced so your real Claude Code CLI (and its sign-in) is never run. It refuses to
run if another debug build is already running, and it checks that the app it drives is
using the sandbox. It drives the UI through the debug build's local control socket, which
snapshots the webview. That's why native macOS UI (notifications, the Dock, permission
prompts) isn't captured.

Review every image before committing it.

## Publishing

[`.github/workflows/docs.yml`](../.github/workflows/docs.yml) builds the site on every pull
request that touches `site/` or `docs/images/`, and builds and deploys it to GitHub Pages
on every push to `main` that touches them. You can also run it by hand from the Actions tab.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Keeping it current

- Every pull request with a user-facing change updates the guide in the same PR (the PR
  template has a checkbox).
- The release PR opened by the Version workflow lists the changes since the last
  release. Before merging it, check that each user-facing one is covered here, and that
  screenshots still match the app. If the UI changed, run `pnpm capture`.
- The guide always describes `main`, which is also what the next release contains. Don't
  add version badges. Link to `releases/latest` rather than naming versions.
