/**
 * What an AI draft sends and never sends. Shown before AI drafts are turned on and again before
 * every generation. Keep in step with `build_payload` in src-tauri/src/resume.rs.
 */
export const SENT_CATEGORIES = [
  "The project name, and the description and next step you wrote",
  "Titles and states of up to 8 of the project’s most relevant sessions, with branch names and PR numbers",
  "Your notes on those sessions",
  "Up to 12 recent activity events from the last 14 days (for example “finished its turn”)",
];

export const NEVER_SENT =
  "Never sent: transcripts, prompts, tool output, file contents, folder paths, links, email addresses, account details or session IDs. Paths, links, emails and token-like strings in titles and notes are replaced before sending.";

export const HOW_IT_RUNS =
  "Drafts run through the Claude Code CLI installed on this Mac, with its own sign-in, and count against your Claude plan. Hoku never reads or stores credentials. Each draft is a single one-off request with every tool disabled, your customizations off (no CLAUDE.md, hooks, plugins or MCP servers) and no saved Claude session.";
