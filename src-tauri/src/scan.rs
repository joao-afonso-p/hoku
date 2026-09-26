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
        match db::upsert_discovered(c, provider, adapter.key(), d, project, Some(account))? {
            db::UpsertOutcome::New => result.new += 1,
            db::UpsertOutcome::Updated => result.updated += 1,
            db::UpsertOutcome::Unchanged => {}
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
