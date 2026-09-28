// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

const repo = "https://github.com/joao-afonso-p/hoku";

// Published at https://joao-afonso-p.github.io/hoku/ (GitHub Pages project site).
// Internal links must include the base: [Install](/hoku/start/install/).
export default defineConfig({
  site: "https://joao-afonso-p.github.io",
  base: "/hoku",
  trailingSlash: "always",
  // Screenshots live in ../docs/images, shared with the README and contributor docs.
  vite: { server: { fs: { allow: [".."] } } },
  integrations: [
    starlight({
      title: "Hoku",
      description:
        "User guide for Hoku, a local-first macOS app that organizes and reopens your Claude Code, Codex and Claude Desktop sessions.",
      logo: { src: "../src/assets/hoku-mark-96.png", alt: "" },
      favicon: "/favicon.png",
      social: [{ icon: "github", label: "Hoku on GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      lastUpdated: true,
      customCss: ["./src/styles/custom.css"],
      plugins: [starlightLinksValidator()],
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Install and update", slug: "start/install" },
            { label: "First run", slug: "start/first-run" },
            { label: "A tour of Hoku", slug: "start/tour" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "The Galaxy", slug: "guides/galaxy" },
            { label: "Projects", slug: "guides/projects" },
            { label: "Sessions and the inspector", slug: "guides/sessions" },
            { label: "Getting back to a session", slug: "guides/opening-sessions" },
            { label: "Needs You and live status", slug: "guides/needs-you" },
            { label: "Follow up", slug: "guides/follow-up" },
            { label: "Activity", slug: "guides/activity" },
            { label: "Search with ⌘K", slug: "guides/search" },
            { label: "Project Resume", slug: "guides/resume" },
            { label: "Recaps", slug: "guides/recaps" },
            { label: "Adding sessions by hand", slug: "guides/adding-sessions" },
            { label: "Archive, delete and forget", slug: "guides/cleaning-up" },
          ],
        },
        {
          label: "Providers",
          items: [
            { label: "Overview", slug: "providers" },
            { label: "Claude Code", slug: "providers/claude-code" },
            { label: "Codex Desktop", slug: "providers/codex" },
            { label: "Claude Desktop", slug: "providers/claude-desktop" },
          ],
        },
        {
          label: "Privacy and data",
          items: [
            { label: "How Hoku handles your data", slug: "privacy" },
            { label: "Your data: backup, reset, uninstall", slug: "privacy/your-data" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Keyboard shortcuts", slug: "reference/shortcuts" },
            { label: "Settings", slug: "reference/settings" },
            { label: "Known limitations", slug: "reference/limitations" },
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
          ],
        },
        {
          label: "More",
          items: [
            { label: "Releases", link: `${repo}/releases`, attrs: { rel: "noopener" } },
            { label: "Report a problem", link: `${repo}/issues/new/choose`, attrs: { rel: "noopener" } },
            { label: "Contributing", link: `${repo}/blob/main/CONTRIBUTING.md`, attrs: { rel: "noopener" } },
          ],
        },
      ],
    }),
  ],
});
