//! Scan orchestration: run adapters (off the UI thread), merge into our DB, report honestly.

use crate::association::{match_project, suggest_projects};
use crate::db;
use crate::models::*;
use crate::providers::{ScanOutcome, SessionAdapter};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

/// Account hints known before scanning (e.g. the email `claude auth status` reports).
pub type AccountHints = HashMap<&'static str, String>;

pub fn run_scan(
    conn: &Mutex<Connection>,
    adapters: &[Box<dyn SessionAdapter>],
    only: Option<&[String]>,
    hints: &AccountHints,
) -> ScanReport {
    let started_at = db::now_iso();
    let mut results = Vec::new();
    let mut project_hints = Vec::new();

    for adapter in adapters {
        if let Some(list) = only {
            if !list.iter().any(|k| k == adapter.key()) {
                continue;
            }
        }
        let started = db::now_iso();
        // Filesystem / foreign-DB work happens without holding our DB lock.
        let outcome = adapter.scan();
        project_hints.extend(adapter.project_hints());

        let mut result = ProviderScanResult {
            adapter: adapter.key().into(),
            provider: adapter.provider(),
            label: adapter.label().into(),
            status: "ok".into(),
            found: 0,
            new: 0,
            updated: 0,
            message: None,
            detail: None,
        };
        let c = conn.lock().expect("db lock");
        match outcome {
            Ok(ScanOutcome::Unavailable(msg)) => {
                result.status = "unavailable".into();
                result.message = Some(msg);
            }
            Err(e) => {
                result.status = "error".into();
                result.message = Some(e.message);
                result.detail = e.detail;
            }
            Ok(ScanOutcome::Found(found)) => {
                result.found = found.len();
                if let Err(e) = merge(&c, adapter.as_ref(), &found, hints, &mut result) {
                    result.status = "error".into();
                    result.message = Some("Discovered sessions couldn't be saved.".into());
                    result.detail = Some(e.to_string());
                }
            }
        }
        let _ = db::record_scan(&c, &started, &result);
        results.push(result);
    }

    // Claude chats have no safe local index. Say so rather than pretending to scan.
    if only
        .map(|l| l.iter().any(|k| k == "claude-chat"))
        .unwrap_or(true)
    {
        results.push(ProviderScanResult {
            adapter: "claude-chat".into(),
            provider: Provider::Claude,
            label: "Claude Desktop · Chats".into(),
            status: "manual-only".into(),
            found: 0,
            new: 0,
            updated: 0,
            message: Some("Chats live on claude.ai. Add them by pasting a link.".into()),
            detail: None,
        });
    }

    let suggestions = {
        let c = conn.lock().expect("db lock");
        suggestions(&c, &project_hints).unwrap_or_default()
    };

    ScanReport {
        started_at,
        finished_at: db::now_iso(),
        results,
        suggestions,
    }
}

fn merge(
    c: &Connection,
    adapter: &dyn SessionAdapter,
    found: &[DiscoveredSession],
    hints: &AccountHints,
    result: &mut ProviderScanResult,
) -> rusqlite::Result<()> {
    let provider = adapter.provider();
    let projects = db::list_projects(c)?;
    let account_provider = provider.account_provider();
    c.execute_batch("BEGIN")?;
    let mut seen = Vec::with_capacity(found.len());
    for d in found {
        let project = match_project(
            &projects,
            d.working_directory.as_deref(),
            d.repository.as_deref(),
        )
        .map(|p| p.id.clone());
        let hint = d
            .account_hint
            .as_deref()
            .or(hints.get(account_provider).map(String::as_str));
        let account = db::resolve_account(c, account_provider, hint)?;
        // Started from a project in Hoku: it belongs there, wherever it ran.
        let launched = db::take_pending_launch(c, provider, &d.external_id)?;
        let project = launched.clone().or(project);
        match db::upsert_discovered(c, provider, adapter.key(), d, project, Some(account))? {
            db::UpsertOutcome::New => result.new += 1,
            db::UpsertOutcome::Updated => result.updated += 1,
            db::UpsertOutcome::Unchanged | db::UpsertOutcome::Forgotten => {}
        }
        if let Some(project_id) = launched {
            db::assign_launched(c, provider, &d.external_id, &project_id)?;
        }
        seen.push(d.external_id.clone());
    }
    db::flag_missing(c, provider, adapter.key(), &seen)?;
    c.execute_batch("COMMIT")
}

pub fn suggestions(
    c: &Connection,
    hints: &[ProjectHint],
) -> rusqlite::Result<Vec<ProjectSuggestion>> {
    let projects = db::list_projects(c)?;
    let unassigned: Vec<(Option<String>, Option<String>)> = db::list_sessions(c)?
        .into_iter()
        .filter(|s| {
            s.project_id.is_none() && !s.project_locked && s.source.as_deref() != Some("demo")
        })
        .map(|s| (s.working_directory, s.repository))
        .collect();
    Ok(suggest_projects(&unassigned, hints, &projects))
}

/// After projects change, place unassigned (and not user-pinned) sessions by root.
pub fn reassociate(c: &Connection) -> rusqlite::Result<usize> {
    let projects = db::list_projects(c)?;
    let mut n = 0;
    for s in db::list_sessions(c)? {
        if s.project_id.is_some() || s.project_locked {
            continue;
        }
        if let Some(p) = match_project(
            &projects,
            s.working_directory.as_deref(),
            s.repository.as_deref(),
        ) {
            c.execute(
                "UPDATE sessions SET project_id = ?2, updated_at = ?3 WHERE id = ?1",
                rusqlite::params![s.id, p.id, db::now_iso()],
            )?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, ProjectInput};

    struct Found(Vec<DiscoveredSession>);
    impl SessionAdapter for Found {
        fn key(&self) -> &'static str {
            "claude-code-transcripts"
        }
        fn provider(&self) -> Provider {
            Provider::ClaudeCode
        }
        fn label(&self) -> &'static str {
            "Found"
        }
        fn scan(&self) -> Result<ScanOutcome, HubError> {
            Ok(ScanOutcome::Found(self.0.clone()))
        }
    }

    fn project(c: &Connection, name: &str, root: &str) -> Project {
        db::create_project(
            c,
            ProjectInput {
                name: name.into(),
                root_path: Some(root.into()),
                icon: None,
                color: None,
                is_demo: false,
            },
        )
        .unwrap()
    }

    fn session(ext: &str, cwd: &str) -> DiscoveredSession {
        DiscoveredSession {
            external_id: ext.into(),
            title: "New".into(),
            working_directory: Some(cwd.into()),
            ..Default::default()
        }
    }

    #[test]
    fn a_session_started_for_a_project_joins_it_wherever_it_ran() {
        let conn = open_in_memory();
        let atlas = project(&conn, "Atlas", "/work/atlas");
        let other = project(&conn, "Other", "/work/other");
        db::add_pending_launch(&conn, Provider::ClaudeCode, "started-1", &atlas.id).unwrap();
        let db = Mutex::new(conn);
        let adapters: Vec<Box<dyn SessionAdapter>> = vec![Box::new(Found(vec![
            // Ran inside another project's root, but was started for Atlas.
            session("started-1", "/work/other/sub"),
            session("plain-1", "/work/other"),
        ]))];
        run_scan(&db, &adapters, None, &AccountHints::new());

        let c = db.lock().unwrap();
        let started = db::find_session_by_external(&c, Provider::ClaudeCode, "started-1")
            .unwrap()
            .unwrap();
        assert_eq!(started.project_id.as_deref(), Some(atlas.id.as_str()));
        assert!(started.project_locked, "a launch is an explicit choice");
        let plain = db::find_session_by_external(&c, Provider::ClaudeCode, "plain-1")
            .unwrap()
            .unwrap();
        assert_eq!(plain.project_id.as_deref(), Some(other.id.as_str()));
        assert!(!plain.project_locked);
        // The marker is used up.
        assert_eq!(
            db::take_pending_launch(&c, Provider::ClaudeCode, "started-1").unwrap(),
            None
        );
    }

    #[test]
    fn deleting_the_project_drops_its_pending_launches() {
        let conn = open_in_memory();
        let atlas = project(&conn, "Atlas", "/work/atlas");
        db::add_pending_launch(&conn, Provider::ClaudeCode, "started-1", &atlas.id).unwrap();
        db::delete_project(&conn, &atlas.id).unwrap();
        assert_eq!(
            db::take_pending_launch(&conn, Provider::ClaudeCode, "started-1").unwrap(),
            None
        );
    }
}
