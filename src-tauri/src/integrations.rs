//! What's installed, what's signed in, and what can be indexed. Three separate questions.
//! Account state comes only from official CLIs that print status — never from token files.

use crate::providers::{RuntimeCapabilities, SessionAdapter};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub name: String,
    /// "app" | "cli"
    pub kind: String,
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub bundled_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    /// "connected" | "disconnected" | "unknown"
    pub status: String,
    pub label: String,
    pub detail: Option<String>,
    /// Human description of how auth is managed.
    pub managed_by: String,
    /// Stable, non-secret identifier used to match sessions to accounts (e.g. an email).
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub adapter: String,
    pub label: String,
    /// "indexed-read-only" | "manual-only" | "unavailable"
    pub discovery: String,
    /// "direct" | "fallback" | "unavailable"
    pub open: String,
    pub detail: String,
    /// What live runtime state this source can report, honestly.
    pub runtime: RuntimeCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGroup {
    pub id: String,
    pub name: String,
    pub account: AccountState,
    pub components: Vec<Component>,
    pub capabilities: Vec<Capability>,
}

fn app_component(id: &str, name: &str, app: crate::platform::InstalledApp) -> Component {
    Component {
        id: id.into(),
        name: name.into(),
        kind: "app".into(),
        installed: app.installed,
        running: app.running,
        version: app.version,
        path: app.path,
        bundled_path: None,
    }
}

/// Resolve a CLI the way a login shell would, plus well-known install locations.
/// GUI apps don't inherit the user's shell PATH, so we check explicitly.
pub fn find_cli(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let home = PathBuf::from(crate::association::home_dir());
    let mut candidates = vec![
        home.join(".local/bin").join(name),
        home.join(".claude/local").join(name),
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/usr/bin").join(name),
        home.join(".npm-global/bin").join(name),
        home.join(".bun/bin").join(name),
    ];
    if let Ok(path) = std::env::var("PATH") {
        candidates.extend(path.split(':').map(|d| PathBuf::from(d).join(name)));
    }
    candidates.extend(extra.iter().cloned());
    candidates.into_iter().find(|p| p.is_file())
}

pub(crate) fn cli_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s.split_whitespace()
        .find(|w| {
            w.chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        })
        .map(str::to_string)
}

fn cli_component(id: &str, name: &str, bin: Option<&PathBuf>) -> Component {
    Component {
        id: id.into(),
        name: name.into(),
        kind: "cli".into(),
        installed: bin.is_some(),
        running: false,
        version: bin.and_then(|b| cli_version(b)),
        path: bin.map(|b| b.to_string_lossy().into_owned()),
        bundled_path: None,
    }
}

pub fn claude_cli() -> Option<PathBuf> {
    find_cli("claude", &[])
}

pub fn codex_cli() -> (Option<PathBuf>, Option<PathBuf>) {
    let on_path = find_cli("codex", &[]);
    (on_path, crate::platform::bundled_codex_cli())
}

/// Parse `claude auth status` JSON. Only non-secret fields are read.
pub fn parse_claude_auth(raw: &str) -> AccountState {
    let managed_by = "Claude Code CLI · claude.ai sign-in".to_string();
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return AccountState {
            status: "unknown".into(),
            label: "Status unavailable".into(),
            detail: None,
            managed_by,
            hint: None,
        };
    };
    let logged_in = v.get("loggedIn").and_then(|b| b.as_bool()).unwrap_or(false);
    if !logged_in {
        return AccountState {
            status: "disconnected".into(),
            label: "Signed out".into(),
            detail: Some("Run `claude auth login` in a terminal.".into()),
            managed_by,
            hint: None,
        };
    }
    let email = v.get("email").and_then(|s| s.as_str()).map(str::to_string);
    let org = v.get("orgName").and_then(|s| s.as_str());
    let plan = v.get("subscriptionType").and_then(|s| s.as_str());
    let detail = match (org, plan) {
        (Some(o), Some(p)) => Some(format!("{o} · {p} plan")),
        (Some(o), None) => Some(o.to_string()),
        (None, Some(p)) => Some(format!("{p} plan")),
        _ => None,
    };
    AccountState {
        status: "connected".into(),
        label: email.clone().unwrap_or_else(|| "Signed in".into()),
        detail,
        managed_by,
        hint: email,
    }
}

pub fn parse_codex_login(stdout: &str, success: bool) -> AccountState {
    let managed_by = "Codex app · ChatGPT sign-in".to_string();
    let line = stdout.lines().next().unwrap_or("").trim().to_string();
    if success && line.to_lowercase().starts_with("logged in") {
        AccountState {
            status: "connected".into(),
            label: "Connected externally".into(),
            detail: Some(line),
            managed_by,
            hint: None,
        }
    } else if line.to_lowercase().contains("not logged in") {
        AccountState {
            status: "disconnected".into(),
            label: "Signed out".into(),
            detail: Some("Sign in from the Codex app.".into()),
            managed_by,
            hint: None,
        }
    } else {
        AccountState {
            status: "unknown".into(),
            label: "Authentication managed by provider app".into(),
            detail: None,
            managed_by,
            hint: None,
        }
    }
}

pub fn detect(adapters: &[Box<dyn SessionAdapter>]) -> Vec<ProviderGroup> {
    let home = PathBuf::from(crate::association::home_dir());
    let runtime_of = |key: &str| {
        adapters
            .iter()
            .find(|a| a.key() == key)
            .map(|a| a.runtime_capabilities())
            .unwrap_or_else(|| {
                RuntimeCapabilities::none(
                    "Chats live on claude.ai; Hoku can't see whether one is running",
                )
            })
    };

    // Claude
    let claude_app = app_component(
        "claude-desktop",
        "Claude Desktop",
        crate::platform::claude_desktop(),
    );
    let claude_bin = claude_cli();
    let claude_code = cli_component("claude-code", "Claude Code", claude_bin.as_ref());
    let claude_account = claude_bin
        .as_ref()
        .and_then(|b| Command::new(b).args(["auth", "status"]).output().ok())
        .map(|o| parse_claude_auth(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_else(|| AccountState {
            status: if claude_app.installed {
                "unknown".into()
            } else {
                "disconnected".into()
            },
            label: if claude_app.installed {
                "Authentication managed by provider app".into()
            } else {
                "Not set up".into()
            },
            detail: None,
            managed_by: "Claude Desktop".into(),
            hint: None,
        });
    let cowork_dir = crate::platform::cowork_sessions_dir(&home);
    let claude_caps = vec![
        Capability {
            adapter: "claude-code-transcripts".into(),
            runtime: runtime_of("claude-code-transcripts"),
            label: "Claude Code sessions".into(),
            discovery: if home.join(".claude/projects").is_dir() {
                "indexed-read-only"
            } else {
                "unavailable"
            }
            .into(),
            open: if claude_code.installed {
                "direct"
            } else {
                "unavailable"
            }
            .into(),
            detail: "Transcripts in ~/.claude/projects · resume, attach or focus in your terminal"
                .into(),
        },
        Capability {
            adapter: "claude-chat".into(),
            runtime: runtime_of("claude-chat"),
            label: "Claude chats".into(),
            discovery: "manual-only".into(),
            open: if claude_app.installed {
                "direct"
            } else {
                "fallback"
            }
            .into(),
            detail:
                "Chats are stored by Claude online. Add them by link; they open through claude://"
                    .into(),
        },
        Capability {
            adapter: "claude-cowork".into(),
            runtime: runtime_of("claude-cowork"),
            label: "Cowork sessions".into(),
            discovery: if cowork_dir.is_dir() {
                "indexed-read-only"
            } else {
                "unavailable"
            }
            .into(),
            open: if claude_app.installed {
                "direct"
            } else {
                "unavailable"
            }
            .into(),
            detail: "Local session metadata written by Claude Desktop".into(),
        },
    ];

    // Codex
    let codex_app = app_component(
        "codex-desktop",
        "Codex Desktop",
        crate::platform::codex_desktop(),
    );
    let (codex_path_cli, codex_bundled) = codex_cli();
    let mut codex_cli_component = cli_component("codex-cli", "Codex CLI", codex_path_cli.as_ref());
    if !codex_cli_component.installed {
        codex_cli_component.bundled_path = codex_bundled
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());
    }
    let codex_account = codex_path_cli
        .as_ref()
        .or(codex_bundled.as_ref())
        .and_then(|b| Command::new(b).args(["login", "status"]).output().ok())
        .map(|o| {
            let mut text = String::from_utf8_lossy(&o.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&o.stderr));
            parse_codex_login(&text, o.status.success())
        })
        .unwrap_or_else(|| parse_codex_login("", false));
    let codex_caps = vec![Capability {
        adapter: "codex-state-db".into(),
        runtime: runtime_of("codex-state-db"),
        label: "Codex threads".into(),
        discovery: if home.join(".codex").is_dir() { "indexed-read-only" } else { "unavailable" }.into(),
        open: if codex_app.installed { "direct" } else { "fallback" }.into(),
        detail: "Thread index in ~/.codex/state_*.sqlite, read-only · opens through codex://threads/<id>".into(),
    }];

    vec![
        ProviderGroup {
            id: "claude".into(),
            name: "Claude".into(),
            account: claude_account,
            components: vec![claude_app, claude_code],
            capabilities: claude_caps,
        },
        ProviderGroup {
            id: "codex".into(),
            name: "Codex".into(),
            account: codex_account,
            components: vec![codex_app, codex_cli_component],
            capabilities: codex_caps,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_auth_reads_only_public_fields() {
        let a = parse_claude_auth(
            r#"{"loggedIn":true,"email":"a@b.c","orgName":"Lumen","subscriptionType":"team","token":"SECRET"}"#,
        );
        assert_eq!(a.status, "connected");
        assert_eq!(a.label, "a@b.c");
        assert_eq!(a.detail.as_deref(), Some("Lumen · team plan"));
        assert!(!format!("{a:?}").contains("SECRET"));
        assert_eq!(
            parse_claude_auth(r#"{"loggedIn":false}"#).status,
            "disconnected"
        );
        assert_eq!(parse_claude_auth("garbage").status, "unknown");
    }

    #[test]
    fn codex_login_status() {
        assert_eq!(
            parse_codex_login("Logged in using ChatGPT\n", true).status,
            "connected"
        );
        assert_eq!(
            parse_codex_login("Not logged in", false).status,
            "disconnected"
        );
    }
}
