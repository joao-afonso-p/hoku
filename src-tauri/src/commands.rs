//! IPC surface. Thin: validate, delegate to db / scan / launch, map errors to HubError.

use crate::db::{self, ManualSessionInput, ProjectInput, SessionPatch};
use crate::integrations;
use crate::launch::{self, LaunchContext, OpenResult};
use crate::models::*;
use crate::providers::{self, claude_desktop::normalize_chat_reference, SessionAdapter};
use crate::runtime::{self, MonitorState};
use crate::scan;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub adapters: Arc<Vec<Box<dyn SessionAdapter>>>,
    pub monitor: Arc<Mutex<MonitorState>>,
    pub claude_home: std::path::PathBuf,
}

type Db<'a> = State<'a, AppState>;

fn lock(state: &AppState) -> std::sync::MutexGuard<'_, Connection> {
    state.db.lock().expect("db lock poisoned")
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> HubResult<T> + Send + 'static,
) -> HubResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| HubError::with_detail("A background task failed.", e))?
}

// ───────────────────────────── read ─────────────────────────────

#[tauri::command]
pub fn get_snapshot(state: Db) -> HubResult<HubSnapshot> {
    Ok(db::snapshot(&lock(&state))?)
}

// ───────────────────────────── projects ─────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArgs {
    name: String,
    root_path: Option<String>,
    color: Option<String>,
    icon: Option<String>,
}

#[tauri::command]
pub fn create_project(state: Db, input: ProjectArgs) -> HubResult<Project> {
    let c = lock(&state);
    let p = db::create_project(
        &c,
        ProjectInput {
            name: input.name,
            root_path: input.root_path,
            icon: input.icon,
            color: input.color,
            is_demo: false,
        },
    )?;
    scan::reassociate(&c)?;
    Ok(p)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatchArgs {
    name: Option<String>,
    #[serde(default, with = "double_option")]
    root_path: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    color: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    icon: Option<Option<String>>,
}

#[tauri::command]
pub fn update_project(state: Db, id: String, patch: ProjectPatchArgs) -> HubResult<Project> {
    let c = lock(&state);
    let p = db::update_project(
        &c,
        &id,
        patch.name,
        patch.root_path,
        patch.color,
        patch.icon,
    )?;
    scan::reassociate(&c)?;
    Ok(p)
}

#[tauri::command]
pub fn archive_project(state: Db, id: String, archived: bool) -> HubResult<Project> {
    db::set_project_archived(&lock(&state), &id, archived)
}

#[tauri::command]
pub fn delete_project(state: Db, id: String) -> HubResult<()> {
    db::delete_project(&lock(&state), &id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionArgs {
    name: String,
    root_path: String,
    color: Option<String>,
}

#[tauri::command]
pub fn create_projects_from_suggestions(
    state: Db,
    suggestions: Vec<SuggestionArgs>,
) -> HubResult<usize> {
    let c = lock(&state);
    for s in suggestions {
        db::create_project(
            &c,
            ProjectInput {
                name: s.name,
                root_path: Some(s.root_path),
                icon: None,
                color: s.color,
                is_demo: false,
            },
        )?;
    }
    Ok(scan::reassociate(&c)?)
}

#[tauri::command]
pub async fn project_suggestions(state: Db<'_>) -> HubResult<Vec<ProjectSuggestion>> {
    let dbh = state.db.clone();
    let adapters = state.adapters.clone();
    blocking(move || {
        let hints: Vec<ProjectHint> = adapters.iter().flat_map(|a| a.project_hints()).collect();
        Ok(scan::suggestions(&dbh.lock().expect("db"), &hints)?)
    })
    .await
}

// ───────────────────────────── sessions ─────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSessionArgs {
    provider: Provider,
    reference: String,
    title: String,
    project_id: Option<String>,
    provider_account_id: Option<String>,
    working_directory: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedReference {
    pub external_id: String,
    pub deep_link: Option<String>,
    pub source_url: Option<String>,
    pub kind: String,
    pub summary: String,
}

pub fn parse_reference_inner(provider: Provider, input: &str) -> HubResult<ParsedReference> {
    let raw = input.trim();
    match provider {
        Provider::Claude => {
            let r = normalize_chat_reference(raw)?;
            let summary = match r.kind.as_str() {
                "project" => "Claude project",
                "cowork" => "Claude Cowork session",
                _ => "Claude conversation",
            };
            Ok(ParsedReference {
                external_id: r.id,
                deep_link: Some(r.deep_link),
                source_url: r.web_url,
                kind: r.kind,
                summary: summary.into(),
            })
        }
        Provider::Codex => {
            let id = raw
                .strip_prefix("codex://threads/")
                .unwrap_or(raw)
                .trim_end_matches('/');
            launch::validate_id(id).map_err(|_| {
                HubError::with_detail("That isn't a Codex thread ID or codex://threads link.", raw)
            })?;
            Ok(ParsedReference {
                external_id: id.into(),
                deep_link: Some(format!("codex://threads/{id}")),
                source_url: None,
                kind: "thread".into(),
                summary: "Codex thread".into(),
            })
        }
        Provider::ClaudeCode => {
            let id = raw
                .strip_prefix("claude --resume ")
                .or_else(|| raw.strip_prefix("claude -r "))
                .unwrap_or(raw)
                .trim();
            launch::validate_id(id)
                .map_err(|_| HubError::with_detail("That isn't a Claude Code session ID.", raw))?;
            Ok(ParsedReference {
                external_id: id.into(),
                deep_link: None,
                source_url: None,
                kind: "session".into(),
                summary: "Claude Code session".into(),
            })
        }
    }
}

#[tauri::command]
pub fn parse_reference(provider: Provider, input: String) -> HubResult<ParsedReference> {
    parse_reference_inner(provider, &input)
}

#[tauri::command]
pub fn add_manual_session(state: Db, input: ManualSessionArgs) -> HubResult<Session> {
    let parsed = parse_reference_inner(input.provider, &input.reference)?;
    let wd = input
        .working_directory
        .map(|d| db::normalize_root(&d))
        .filter(|d| d != "/");
    if input.provider == Provider::ClaudeCode {
        match wd.as_deref() {
            Some(d) if std::path::Path::new(d).is_dir() => {}
            Some(d) => return Err(HubError::with_detail("That working directory doesn't exist.", d)),
            None => return Err(HubError::new("Claude Code sessions resume from their working directory. Add the folder it ran in.")),
        }
    }
    let c = lock(&state);
    let account = match input.provider_account_id {
        Some(a) => Some(a),
        None => Some(db::resolve_account(
            &c,
            input.provider.account_provider(),
            None,
        )?),
    };
    db::insert_manual_session(
        &c,
        ManualSessionInput {
            provider: input.provider,
            external_id: Some(parsed.external_id),
            title: input.title,
            project_id: input.project_id,
            provider_account_id: account,
            working_directory: wd.clone(),
            deep_link: parsed.deep_link,
            source_url: parsed.source_url,
            notes: input.notes,
            source: "manual".into(),
            metadata: Some(json!({ "referenceKind": parsed.kind })),
            last_activity_at: None,
            runtime: None,
            favorite: false,
        },
    )
    .map(|mut s| {
        if let Some(d) = wd {
            s.repository = crate::association::repository_root(&d);
            let _ = c.execute(
                "UPDATE sessions SET repository = ?2 WHERE id = ?1",
                rusqlite::params![s.id, s.repository],
            );
        }
        let _ = db::insert_event(
            &c,
            &ActivityEvent {
                id: db::new_id(),
                session_id: s.id.clone(),
                event_type: "created".into(),
                provider: s.provider,
                timestamp: db::now_iso(),
                title: Some(s.title.clone()),
                from_state: None,
                to_state: None,
                reason: Some("Added manually".into()),
                metadata: None,
            },
        );
        s
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatchArgs {
    title: Option<String>,
    #[serde(default, with = "double_option")]
    notes: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    project_id: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    provider_account_id: Option<Option<String>>,
    favorite: Option<bool>,
}

#[tauri::command]
pub fn update_session(state: Db, id: String, patch: SessionPatchArgs) -> HubResult<Session> {
    db::update_session(
        &lock(&state),
        &id,
        SessionPatch {
            title: patch.title,
            notes: patch.notes,
            project_id: patch.project_id,
            provider_account_id: patch.provider_account_id,
            favorite: patch.favorite,
        },
    )
}

#[tauri::command]
pub fn delete_session(state: Db, id: String) -> HubResult<()> {
    db::delete_session(&lock(&state), &id)
}

#[tauri::command]
pub fn set_link(state: Db, from: String, to: String, linked: bool) -> HubResult<()> {
    db::set_link(&lock(&state), &from, &to, linked)
}

// ───────────────────────────── opening ─────────────────────────────

#[tauri::command]
pub async fn open_session(
    app: tauri::AppHandle,
    state: Db<'_>,
    id: String,
) -> HubResult<OpenResult> {
    let dbh = state.db.clone();
    let claude_home = state.claude_home.clone();
    let hoku_fullscreen = {
        use tauri::Manager;
        app.get_webview_window("main")
            .and_then(|w| w.is_fullscreen().ok())
            .unwrap_or(false)
    };
    // Yield the foreground now, synchronously, while Hoku is certainly still frontmost.
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        launch::yield_to(&launch::TERMINAL_BUNDLES);
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    blocking(move || {
        let (session, pref) = {
            let c = dbh.lock().expect("db");
            let s = db::get_session(&c, &id)?
                .ok_or_else(|| HubError::new("That session no longer exists."))?;
            let pref = db::get_setting(&c, "terminal")?
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "auto".into());
            (s, pref)
        };
        if session.source.as_deref() == Some("demo") {
            return Err(HubError::new(
                "This is a demo session. It isn't connected to a real conversation.",
            ));
        }
        let ctx = LaunchContext {
            claude_bin: integrations::claude_cli().map(|p| p.to_string_lossy().into_owned()),
            terminal_pref: pref,
            claude_home,
            hoku_fullscreen,
        };
        let result = launch::open_session(&session, &ctx)?;
        db::mark_opened(&dbh.lock().expect("db"), &session.id)?;
        if let Some(bundle) = result.activate.clone() {
            let b = bundle.clone();
            let _ = app.run_on_main_thread(move || {
                launch::activate_app(&b);
            });
            // Verify, and retry once through LaunchServices if the terminal still isn't in front.
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let _ = app2.run_on_main_thread(move || {
                    if !launch::is_active(&bundle) {
                        launch::open_by_bundle(&bundle);
                        launch::activate_app(&bundle);
                    }
                });
            });
        }
        Ok(result)
    })
    .await
}

/// Whether macOS switches desktops when an app is activated (see launch::spaces_switch_on_activate).
#[tauri::command]
pub fn spaces_switch_enabled() -> bool {
    launch::spaces_switch_on_activate()
}

#[tauri::command]
pub fn open_spaces_settings() -> HubResult<()> {
    launch::open_spaces_settings()
        .map_err(|e| HubError::with_detail("System Settings couldn't be opened.", e))
}

#[tauri::command]
pub fn copy_text(text: String) -> HubResult<()> {
    launch::copy_to_clipboard(&text)
}

#[tauri::command]
pub fn reveal_path(path: String) -> HubResult<()> {
    launch::reveal(&path)
}

#[tauri::command]
pub fn open_provider_app(app: String) -> HubResult<()> {
    let url = match app.as_str() {
        "claude" => "claude://claude.ai/new",
        "codex" => "codex://threads/new",
        _ => return Err(HubError::new("Unknown app.")),
    };
    launch::open_url(url).map_err(|e| HubError::with_detail("The app couldn't be opened.", e))
}

// ───────────────────────────── scanning ─────────────────────────────

fn account_hints() -> scan::AccountHints {
    let mut hints = scan::AccountHints::new();
    if let Some(bin) = integrations::claude_cli() {
        if let Ok(out) = std::process::Command::new(bin)
            .args(["auth", "status"])
            .output()
        {
            if let Some(h) =
                integrations::parse_claude_auth(&String::from_utf8_lossy(&out.stdout)).hint
            {
                hints.insert("claude", h);
            }
        }
    }
    hints
}

#[tauri::command]
pub async fn scan_sessions(state: Db<'_>, adapters: Option<Vec<String>>) -> HubResult<ScanReport> {
    let dbh = state.db.clone();
    let all = state.adapters.clone();
    let monitor = state.monitor.clone();
    blocking(move || {
        let hints = account_hints();
        let report = scan::run_scan(&dbh, &all, adapters.as_deref(), &hints);
        // Keep account labels readable: name auto-created accounts after their hint.
        let c = dbh.lock().expect("db");
        for (provider, hint) in &hints {
            c.execute(
                "UPDATE provider_accounts SET label = ?2, metadata = json_object('hint', ?2) WHERE provider = ?1 AND label = 'Default'",
                rusqlite::params![provider, hint],
            )?;
        }
        db::set_setting(&c, "hasScanned", &json!(true))?;
        drop(c);
        // Newly indexed sessions get a runtime state now, not on the next monitor tick.
        runtime::tick(&dbh, &all, &mut monitor.lock().expect("monitor"));
        Ok(report)
    })
    .await
}

/// Run one runtime pass now (window regained focus). Returns true if anything changed.
#[tauri::command]
pub async fn refresh_runtime(state: Db<'_>) -> HubResult<bool> {
    let dbh = state.db.clone();
    let all = state.adapters.clone();
    let monitor = state.monitor.clone();
    blocking(move || Ok(runtime::tick(&dbh, &all, &mut monitor.lock().expect("monitor")).changed))
        .await
}

#[tauri::command]
pub async fn integration_status(state: Db<'_>) -> HubResult<Vec<integrations::ProviderGroup>> {
    let all = state.adapters.clone();
    blocking(move || Ok(integrations::detect(&all))).await
}

// ───────────────────────────── accounts, settings, demo ─────────────────────────────

#[tauri::command]
pub fn create_account(state: Db, provider: String, label: String) -> HubResult<ProviderAccount> {
    db::create_account(&lock(&state), &provider, &label)
}

#[tauri::command]
pub fn rename_account(state: Db, id: String, label: String) -> HubResult<()> {
    db::rename_account(&lock(&state), &id, &label)
}

#[tauri::command]
pub fn set_setting(state: Db, key: String, value: Value) -> HubResult<()> {
    Ok(db::set_setting(&lock(&state), &key, &value)?)
}

#[tauri::command]
pub fn load_demo(state: Db) -> HubResult<()> {
    crate::demo::load(&lock(&state))
}

#[tauri::command]
pub fn clear_demo(state: Db) -> HubResult<()> {
    Ok(db::clear_demo(&lock(&state))?)
}

#[tauri::command]
pub fn database_path(app: tauri::AppHandle) -> HubResult<String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| HubError::with_detail("No data folder.", e))?;
    Ok(dir.join("hub.sqlite").to_string_lossy().into_owned())
}

pub fn default_adapters() -> Vec<Box<dyn SessionAdapter>> {
    providers::all_adapters()
}

/// Distinguishes "field absent" (None) from "field set to null" (Some(None)) in patches.
mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(d).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_and_claude_code_references() {
        let r = parse_reference_inner(
            Provider::Codex,
            "codex://threads/01920a3e-5b7c-7d21-9f40-3c8e6a1b2d57",
        )
        .unwrap();
        assert_eq!(r.external_id, "01920a3e-5b7c-7d21-9f40-3c8e6a1b2d57");
        assert_eq!(
            r.deep_link.as_deref(),
            Some("codex://threads/01920a3e-5b7c-7d21-9f40-3c8e6a1b2d57")
        );
        let r = parse_reference_inner(
            Provider::ClaudeCode,
            "claude --resume 4d44b29a-bb72-4b82-81b2-79126dae948c",
        )
        .unwrap();
        assert_eq!(r.external_id, "4d44b29a-bb72-4b82-81b2-79126dae948c");
        assert!(parse_reference_inner(Provider::Codex, "not a thread; rm").is_err());
    }
}
