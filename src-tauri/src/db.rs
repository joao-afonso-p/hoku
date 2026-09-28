//! Hoku's own SQLite store. This is the only database we ever write to.

use crate::models::*;
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::path::Path;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        root_path   TEXT,
        icon        TEXT,
        color       TEXT,
        slot        INTEGER NOT NULL UNIQUE,
        is_demo     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    CREATE TABLE provider_accounts (
        id          TEXT PRIMARY KEY,
        provider    TEXT NOT NULL CHECK (provider IN ('claude','codex')),
        label       TEXT NOT NULL,
        auth_mode   TEXT NOT NULL,
        status      TEXT NOT NULL,
        metadata    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    CREATE TABLE sessions (
        id                   TEXT PRIMARY KEY,
        provider             TEXT NOT NULL CHECK (provider IN ('claude-code','claude','codex')),
        provider_account_id  TEXT REFERENCES provider_accounts(id) ON DELETE SET NULL,
        external_id          TEXT,
        title                TEXT NOT NULL,
        project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
        working_directory    TEXT,
        repository           TEXT,
        branch               TEXT,
        source               TEXT,
        source_url           TEXT,
        deep_link            TEXT,
        last_activity_at     TEXT,
        last_opened_at       TEXT,
        activity_state       TEXT NOT NULL DEFAULT 'unknown',
        favorite             INTEGER NOT NULL DEFAULT 0,
        notes                TEXT,
        metadata             TEXT,
        discovery            TEXT NOT NULL DEFAULT 'manual',
        project_locked       INTEGER NOT NULL DEFAULT 0,
        title_locked         INTEGER NOT NULL DEFAULT 0,
        source_missing       INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_sessions_external ON sessions(provider, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX idx_sessions_project ON sessions(project_id);

    CREATE TABLE session_links (
        from_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        to_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL DEFAULT 'related',
        created_at  TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id)
    );

    CREATE TABLE scan_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        adapter      TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT NOT NULL,
        status       TEXT NOT NULL,
        found        INTEGER NOT NULL DEFAULT 0,
        new          INTEGER NOT NULL DEFAULT 0,
        updated      INTEGER NOT NULL DEFAULT 0,
        message      TEXT
    );

    CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    "#,
    // v2 — normalized runtime state + semantic activity timeline. `activity_state` stays as a
    // legacy column (no longer read) so older builds can still open the file.
    r#"
    ALTER TABLE sessions ADD COLUMN runtime_state        TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE sessions ADD COLUMN runtime_confidence   TEXT NOT NULL DEFAULT 'low';
    ALTER TABLE sessions ADD COLUMN runtime_reason       TEXT;
    ALTER TABLE sessions ADD COLUMN runtime_detail       TEXT;
    ALTER TABLE sessions ADD COLUMN runtime_source       TEXT;
    ALTER TABLE sessions ADD COLUMN runtime_action       INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN runtime_since        TEXT;
    ALTER TABLE sessions ADD COLUMN runtime_observed_at  TEXT;

    CREATE TABLE activity_events (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        provider    TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        title       TEXT,
        from_state  TEXT,
        to_state    TEXT,
        reason      TEXT,
        metadata    TEXT
    );
    CREATE INDEX idx_activity_ts ON activity_events(timestamp DESC);
    CREATE INDEX idx_activity_session ON activity_events(session_id, timestamp DESC);

    -- Demo rows have no live source; carry their old liveness over once.
    UPDATE sessions SET runtime_state = CASE activity_state WHEN 'active' THEN 'working' WHEN 'waiting' THEN 'idle' ELSE 'offline' END,
        runtime_confidence = 'high', runtime_source = 'demo'
     WHERE source = 'demo';
    "#,
    // v3 — archived projects: hidden from the Galaxy, everything else kept (and restorable).
    r#"
    ALTER TABLE projects ADD COLUMN archived_at TEXT;
    "#,
];

/// The bundle identifier before Hoku had its own (`com.hoku.app`). The app-data folder is
/// named after it, so an existing index lives there.
pub const LEGACY_IDENTIFIER: &str = "com.aisessionhub.app";

/// First launch under the new identifier: copy the index from the legacy folder (with
/// `VACUUM INTO`, a consistent snapshot including any pending WAL). The legacy file is left
/// untouched as a backup. Returns the path it was copied from, if it did.
pub fn adopt_legacy_index(data_dir: &Path) -> Option<std::path::PathBuf> {
    let target = data_dir.join("hub.sqlite");
    if target.exists() {
        return None;
    }
    let legacy = data_dir
        .parent()?
        .join(LEGACY_IDENTIFIER)
        .join("hub.sqlite");
    if !legacy.is_file() {
        return None;
    }
    let src =
        Connection::open_with_flags(&legacy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    src.execute("VACUUM INTO ?1", [target.to_string_lossy()])
        .ok()?;
    Some(legacy)
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrate(&conn).unwrap();
    conn
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let v = i as i64 + 1;
        if v > version {
            conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {v}; COMMIT;"))?;
        }
    }
    Ok(())
}

fn json_col(v: Option<String>) -> Option<Value> {
    v.and_then(|s| serde_json::from_str(&s).ok())
}

// ───────────────────────────── projects ─────────────────────────────

fn row_project(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get("id")?,
        name: r.get("name")?,
        root_path: r.get("root_path")?,
        icon: r.get("icon")?,
        color: r.get("color")?,
        slot: r.get("slot")?,
        is_demo: r.get::<_, i64>("is_demo")? != 0,
        archived_at: r.get("archived_at")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let mut st = conn.prepare("SELECT * FROM projects ORDER BY slot")?;
    let rows = st.query_map([], row_project)?;
    rows.collect()
}

pub fn get_project(conn: &Connection, id: &str) -> rusqlite::Result<Option<Project>> {
    conn.query_row("SELECT * FROM projects WHERE id = ?", [id], row_project)
        .optional()
}

/// Smallest unused slot ≥ 1. Slot 0 is reserved for the "Unsorted" nebula.
fn next_free_slot(conn: &Connection) -> rusqlite::Result<i64> {
    let mut st = conn.prepare("SELECT slot FROM projects ORDER BY slot")?;
    let used: Vec<i64> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut candidate = 1;
    for s in used {
        if s == candidate {
            candidate += 1;
        } else if s > candidate {
            break;
        }
    }
    Ok(candidate)
}

pub fn normalize_root(path: &str) -> String {
    let trimmed = path.trim();
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        trimmed.to_string()
    };
    let s = expanded.trim_end_matches('/');
    if s.is_empty() {
        "/".into()
    } else {
        s.to_string()
    }
}

pub struct ProjectInput {
    pub name: String,
    pub root_path: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub is_demo: bool,
}

pub fn create_project(conn: &Connection, input: ProjectInput) -> HubResult<Project> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(HubError::new("A project needs a name."));
    }
    let now = now_iso();
    let id = new_id();
    let slot = next_free_slot(conn)?;
    let root = input
        .root_path
        .filter(|s| !s.trim().is_empty())
        .map(|s| normalize_root(&s));
    conn.execute(
        "INSERT INTO projects (id, name, root_path, icon, color, slot, is_demo, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, name, root, input.icon, input.color, slot, input.is_demo as i64, now],
    )?;
    Ok(get_project(conn, &id)?.expect("inserted"))
}

pub fn update_project(
    conn: &Connection,
    id: &str,
    name: Option<String>,
    root_path: Option<Option<String>>,
    color: Option<Option<String>>,
    icon: Option<Option<String>>,
) -> HubResult<Project> {
    let mut p =
        get_project(conn, id)?.ok_or_else(|| HubError::new("That project no longer exists."))?;
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err(HubError::new("A project needs a name."));
        }
        p.name = n;
    }
    if let Some(r) = root_path {
        p.root_path = r
            .filter(|s| !s.trim().is_empty())
            .map(|s| normalize_root(&s));
    }
    if let Some(c) = color {
        p.color = c;
    }
    if let Some(i) = icon {
        p.icon = i;
    }
    conn.execute(
        "UPDATE projects SET name=?2, root_path=?3, color=?4, icon=?5, updated_at=?6 WHERE id=?1",
        params![id, p.name, p.root_path, p.color, p.icon, now_iso()],
    )?;
    Ok(get_project(conn, id)?.expect("exists"))
}

/// Archive (or restore) a project. Sessions, assignments, root path and slot are untouched, so
/// restoring puts it back exactly where it was.
pub fn set_project_archived(conn: &Connection, id: &str, archived: bool) -> HubResult<Project> {
    let at = archived.then(now_iso);
    let n = conn.execute(
        "UPDATE projects SET archived_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, at, now_iso()],
    )?;
    if n == 0 {
        return Err(HubError::new("That project no longer exists."));
    }
    Ok(get_project(conn, id)?.expect("exists"))
}

pub fn delete_project(conn: &Connection, id: &str) -> HubResult<()> {
    // Sessions fall back to Unsorted; explicit assignment to this project is released.
    conn.execute(
        "UPDATE sessions SET project_locked = 0 WHERE project_id = ?",
        [id],
    )?;
    conn.execute("DELETE FROM projects WHERE id = ?", [id])?;
    Ok(())
}

// ───────────────────────────── sessions ─────────────────────────────

fn row_runtime(r: &Row) -> rusqlite::Result<RuntimeStatus> {
    Ok(RuntimeStatus {
        state: RuntimeState::parse(&r.get::<_, String>("runtime_state")?),
        confidence: Confidence::parse(&r.get::<_, String>("runtime_confidence")?),
        reason: r.get("runtime_reason")?,
        detail: r.get("runtime_detail")?,
        source: r.get("runtime_source")?,
        action_required: r.get::<_, i64>("runtime_action")? != 0,
        since: r.get("runtime_since")?,
        last_observed_at: r.get("runtime_observed_at")?,
    })
}

fn row_session(r: &Row) -> rusqlite::Result<Session> {
    let provider: String = r.get("provider")?;
    Ok(Session {
        id: r.get("id")?,
        provider: Provider::parse(&provider).unwrap_or(Provider::Claude),
        provider_account_id: r.get("provider_account_id")?,
        external_id: r.get("external_id")?,
        title: r.get("title")?,
        project_id: r.get("project_id")?,
        working_directory: r.get("working_directory")?,
        repository: r.get("repository")?,
        branch: r.get("branch")?,
        source: r.get("source")?,
        source_url: r.get("source_url")?,
        deep_link: r.get("deep_link")?,
        last_activity_at: r.get("last_activity_at")?,
        last_opened_at: r.get("last_opened_at")?,
        runtime: row_runtime(r)?,
        favorite: r.get::<_, i64>("favorite")? != 0,
        notes: r.get("notes")?,
        metadata: json_col(r.get("metadata")?),
        discovery: r.get("discovery")?,
        project_locked: r.get::<_, i64>("project_locked")? != 0,
        title_locked: r.get::<_, i64>("title_locked")? != 0,
        source_missing: r.get::<_, i64>("source_missing")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn list_sessions(conn: &Connection) -> rusqlite::Result<Vec<Session>> {
    let mut st = conn
        .prepare("SELECT * FROM sessions ORDER BY COALESCE(last_activity_at, created_at) DESC")?;
    let rows = st.query_map([], row_session)?;
    rows.collect()
}

pub fn get_session(conn: &Connection, id: &str) -> rusqlite::Result<Option<Session>> {
    conn.query_row("SELECT * FROM sessions WHERE id = ?", [id], row_session)
        .optional()
}

/// A session that needs a human now, with only what an alert may show about it.
#[derive(Debug, Clone, PartialEq)]
pub struct NeedsYouRow {
    pub session_id: String,
    pub provider: Provider,
    pub project: Option<String>,
    pub state: RuntimeState,
    pub reason: Option<String>,
    pub demo: bool,
}

/// Every session that needs you: `needs_input`, or an error that needs a human. The same rule
/// as `needsYou()` in src/features/runtime/status.ts, so the Dock and the sidebar agree.
pub fn needs_you_sessions(conn: &Connection) -> rusqlite::Result<Vec<NeedsYouRow>> {
    let mut st = conn.prepare(
        "SELECT s.id, s.provider, p.name, s.runtime_state, s.runtime_reason, s.source
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.runtime_state = 'needs_input'
             OR (s.runtime_state = 'error' AND s.runtime_action = 1)",
    )?;
    let rows = st.query_map([], |r| {
        Ok(NeedsYouRow {
            session_id: r.get(0)?,
            provider: Provider::parse(&r.get::<_, String>(1)?).unwrap_or(Provider::Claude),
            project: r.get(2)?,
            state: RuntimeState::parse(&r.get::<_, String>(3)?),
            reason: r.get(4)?,
            demo: r.get::<_, Option<String>>(5)?.as_deref() == Some("demo"),
        })
    })?;
    rows.collect()
}

pub fn find_session_by_external(
    conn: &Connection,
    provider: Provider,
    external_id: &str,
) -> rusqlite::Result<Option<Session>> {
    conn.query_row(
        "SELECT * FROM sessions WHERE provider = ? AND external_id = ?",
        params![provider.as_str(), external_id],
        row_session,
    )
    .optional()
}

pub struct ManualSessionInput {
    pub provider: Provider,
    pub external_id: Option<String>,
    pub title: String,
    pub project_id: Option<String>,
    pub provider_account_id: Option<String>,
    pub working_directory: Option<String>,
    pub deep_link: Option<String>,
    pub source_url: Option<String>,
    pub notes: Option<String>,
    pub source: String,
    pub metadata: Option<Value>,
    pub last_activity_at: Option<String>,
    /// Only demo data sets this; real sessions get their runtime from the monitor.
    pub runtime: Option<RuntimeStatus>,
    pub favorite: bool,
}

pub fn insert_manual_session(conn: &Connection, s: ManualSessionInput) -> HubResult<Session> {
    if let Some(ext) = &s.external_id {
        if let Some(existing) = find_session_by_external(conn, s.provider, ext)? {
            return Err(HubError {
                message: format!(
                    "This session is already in your hub as “{}”.",
                    existing.title
                ),
                detail: Some(format!("{}:{}", s.provider.as_str(), ext)),
            });
        }
    }
    let title = s.title.trim();
    if title.is_empty() {
        return Err(HubError::new(
            "Give the session a title so you can find it later.",
        ));
    }
    let now = now_iso();
    let id = new_id();
    conn.execute(
        "INSERT INTO sessions (id, provider, provider_account_id, external_id, title, project_id,
            working_directory, source, source_url, deep_link, last_activity_at,
            favorite, notes, metadata, discovery, project_locked, title_locked, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'manual',?15,1,?16,?16)",
        params![
            id,
            s.provider.as_str(),
            s.provider_account_id,
            s.external_id,
            title,
            s.project_id,
            s.working_directory,
            s.source,
            s.source_url,
            s.deep_link,
            s.last_activity_at.unwrap_or_else(|| now.clone()),
            s.favorite as i64,
            s.notes.filter(|n| !n.trim().is_empty()),
            s.metadata.map(|m| m.to_string()),
            s.project_id.is_some() as i64,
            now
        ],
    )?;
    if let Some(rt) = &s.runtime {
        write_runtime(conn, &id, rt)?;
    }
    Ok(get_session(conn, &id)?.expect("inserted"))
}

#[derive(Default)]
pub struct SessionPatch {
    pub title: Option<String>,
    pub notes: Option<Option<String>>,
    pub project_id: Option<Option<String>>,
    pub provider_account_id: Option<Option<String>>,
    pub favorite: Option<bool>,
}

pub fn update_session(conn: &Connection, id: &str, patch: SessionPatch) -> HubResult<Session> {
    let mut s =
        get_session(conn, id)?.ok_or_else(|| HubError::new("That session no longer exists."))?;
    if let Some(t) = patch.title {
        let t = t.trim().to_string();
        if t.is_empty() {
            return Err(HubError::new("A session title can't be empty."));
        }
        if t != s.title {
            s.title = t;
            s.title_locked = true;
        }
    }
    if let Some(n) = patch.notes {
        s.notes = n.filter(|n| !n.trim().is_empty());
    }
    if let Some(p) = patch.project_id {
        s.project_id = p;
        // An explicit choice — including "Unsorted" — is sticky across scans.
        s.project_locked = true;
    }
    if let Some(a) = patch.provider_account_id {
        s.provider_account_id = a;
    }
    if let Some(f) = patch.favorite {
        s.favorite = f;
    }
    conn.execute(
        "UPDATE sessions SET title=?2, title_locked=?3, notes=?4, project_id=?5, project_locked=?6,
            provider_account_id=?7, favorite=?8, updated_at=?9 WHERE id=?1",
        params![
            id,
            s.title,
            s.title_locked as i64,
            s.notes,
            s.project_id,
            s.project_locked as i64,
            s.provider_account_id,
            s.favorite as i64,
            now_iso()
        ],
    )?;
    Ok(get_session(conn, id)?.expect("exists"))
}

pub fn delete_session(conn: &Connection, id: &str) -> HubResult<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?", [id])?;
    Ok(())
}

pub fn mark_opened(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET last_opened_at = ?2 WHERE id = ?1",
        params![id, now_iso()],
    )?;
    Ok(())
}

// ───────────────────────────── runtime ─────────────────────────────

pub fn write_runtime(conn: &Connection, id: &str, rt: &RuntimeStatus) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET runtime_state=?2, runtime_confidence=?3, runtime_reason=?4, runtime_detail=?5,
            runtime_source=?6, runtime_action=?7, runtime_since=?8, runtime_observed_at=?9 WHERE id=?1",
        params![
            id,
            rt.state.as_str(),
            rt.confidence.as_str(),
            rt.reason,
            rt.detail,
            rt.source,
            rt.action_required as i64,
            rt.since,
            rt.last_observed_at
        ],
    )?;
    Ok(())
}

/// Heartbeat: the monitor re-confirmed these sessions without a change.
pub fn touch_runtime(conn: &Connection, ids: &[String], at: &str) -> rusqlite::Result<()> {
    let mut st =
        conn.prepare_cached("UPDATE sessions SET runtime_observed_at = ?2 WHERE id = ?1")?;
    for id in ids {
        st.execute(params![id, at])?;
    }
    Ok(())
}

/// Runtime observations can carry fresher activity than the last scan. Only moves forward.
pub fn bump_last_activity(conn: &Connection, id: &str, at: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET last_activity_at = ?2 WHERE id = ?1 AND (last_activity_at IS NULL OR last_activity_at < ?2)",
        params![id, at],
    )?;
    Ok(())
}

// ───────────────────────────── activity events ─────────────────────────────

fn row_event(r: &Row) -> rusqlite::Result<ActivityEvent> {
    let provider: String = r.get("provider")?;
    Ok(ActivityEvent {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        event_type: r.get("type")?,
        provider: Provider::parse(&provider).unwrap_or(Provider::Claude),
        timestamp: r.get("timestamp")?,
        title: r.get("title")?,
        from_state: r
            .get::<_, Option<String>>("from_state")?
            .map(|s| RuntimeState::parse(&s)),
        to_state: r
            .get::<_, Option<String>>("to_state")?
            .map(|s| RuntimeState::parse(&s)),
        reason: r.get("reason")?,
        metadata: json_col(r.get("metadata")?),
    })
}

pub fn insert_event(conn: &Connection, e: &ActivityEvent) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO activity_events (id, session_id, type, provider, timestamp, title, from_state, to_state, reason, metadata)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            e.id,
            e.session_id,
            e.event_type,
            e.provider.as_str(),
            e.timestamp,
            e.title,
            e.from_state.map(|s| s.as_str()),
            e.to_state.map(|s| s.as_str()),
            e.reason,
            e.metadata.as_ref().map(|m| m.to_string())
        ],
    )?;
    Ok(())
}

/// The newest event for a session, used to avoid recording the same transition twice.
pub fn last_event(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<ActivityEvent>> {
    conn.query_row(
        "SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1",
        [session_id],
        row_event,
    )
    .optional()
}

/// Events newer than `since`, newest first, capped.
pub fn list_events(
    conn: &Connection,
    since: &str,
    limit: usize,
) -> rusqlite::Result<Vec<ActivityEvent>> {
    let mut st = conn.prepare("SELECT * FROM activity_events WHERE timestamp >= ?1 ORDER BY timestamp DESC, rowid DESC LIMIT ?2")?;
    let rows = st.query_map(params![since, limit as i64], row_event)?;
    rows.collect()
}

pub fn prune_events(conn: &Connection, before: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM activity_events WHERE timestamp < ?", [before])
}

// ───────────────────────────── discovery upsert ─────────────────────────────

pub enum UpsertOutcome {
    New,
    Updated,
    Unchanged,
}

/// Merge a discovered session into the hub. User-owned fields (title if renamed, notes,
/// favorite, locked project) are never overwritten by a scan.
pub fn upsert_discovered(
    conn: &Connection,
    provider: Provider,
    source: &str,
    d: &DiscoveredSession,
    project_id: Option<String>,
    account_id: Option<String>,
) -> rusqlite::Result<UpsertOutcome> {
    let now = now_iso();
    let metadata = Value::Object(d.metadata.clone()).to_string();

    match find_session_by_external(conn, provider, &d.external_id)? {
        None => {
            conn.execute(
                "INSERT INTO sessions (id, provider, provider_account_id, external_id, title, project_id,
                    working_directory, repository, branch, source, source_url, deep_link,
                    last_activity_at, metadata, discovery, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'scan',?15,?15)",
                params![
                    new_id(),
                    provider.as_str(),
                    account_id,
                    d.external_id,
                    d.title,
                    project_id,
                    d.working_directory,
                    d.repository,
                    d.branch,
                    source,
                    d.source_url,
                    d.deep_link,
                    d.last_activity_at,
                    metadata,
                    now
                ],
            )?;
            Ok(UpsertOutcome::New)
        }
        Some(existing) => {
            let title = if existing.title_locked {
                existing.title.clone()
            } else {
                d.title.clone()
            };
            let project = if existing.project_locked || existing.project_id.is_some() {
                existing.project_id.clone()
            } else {
                project_id
            };
            let account = existing.provider_account_id.clone().or(account_id);
            let changed = title != existing.title
                || project != existing.project_id
                // The runtime monitor may already have moved last activity forward; only newer counts.
                || d.last_activity_at.as_deref() > existing.last_activity_at.as_deref()
                || d.branch != existing.branch
                || d.working_directory != existing.working_directory
                || existing.source_missing;
            conn.execute(
                "UPDATE sessions SET title=?2, project_id=?3, provider_account_id=?4, working_directory=?5,
                    repository=?6, branch=?7, source_url=?8, deep_link=?9,
                    last_activity_at = CASE WHEN ?10 IS NOT NULL AND (last_activity_at IS NULL OR ?10 > last_activity_at) THEN ?10 ELSE last_activity_at END,
                    metadata=?11, source_missing=0, updated_at=?12
                 WHERE id=?1",
                params![
                    existing.id,
                    title,
                    project,
                    account,
                    d.working_directory,
                    d.repository,
                    d.branch,
                    d.source_url,
                    d.deep_link,
                    d.last_activity_at,
                    metadata,
                    if changed { now } else { existing.updated_at.clone() }
                ],
            )?;
            Ok(if changed {
                UpsertOutcome::Updated
            } else {
                UpsertOutcome::Unchanged
            })
        }
    }
}

/// Sessions from this source that the provider no longer reports get flagged, not deleted —
/// the user may have notes or favorites on them.
pub fn flag_missing(
    conn: &Connection,
    provider: Provider,
    source: &str,
    seen: &[String],
) -> rusqlite::Result<()> {
    let mut st = conn.prepare("SELECT id, external_id FROM sessions WHERE provider = ? AND source = ? AND discovery = 'scan'")?;
    let rows: Vec<(String, Option<String>)> = st
        .query_map(params![provider.as_str(), source], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    for (id, ext) in rows {
        let missing = ext.map(|e| !seen.contains(&e)).unwrap_or(false);
        conn.execute(
            "UPDATE sessions SET source_missing = ?2 WHERE id = ?1",
            params![id, missing as i64],
        )?;
    }
    Ok(())
}

// ───────────────────────────── accounts ─────────────────────────────

fn row_account(r: &Row) -> rusqlite::Result<ProviderAccount> {
    Ok(ProviderAccount {
        id: r.get("id")?,
        provider: r.get("provider")?,
        label: r.get("label")?,
        auth_mode: r.get("auth_mode")?,
        status: r.get("status")?,
        metadata: json_col(r.get("metadata")?),
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn list_accounts(conn: &Connection) -> rusqlite::Result<Vec<ProviderAccount>> {
    let mut st = conn.prepare("SELECT * FROM provider_accounts ORDER BY provider, created_at")?;
    let rows = st.query_map([], row_account)?;
    rows.collect()
}

/// Find the account a discovered session belongs to. Matches on the `hint` stored in
/// metadata (e.g. an email); otherwise falls back to the provider's first account,
/// creating a "Default" one on first use.
pub fn resolve_account(
    conn: &Connection,
    provider: &str,
    hint: Option<&str>,
) -> rusqlite::Result<String> {
    let accounts: Vec<ProviderAccount> = list_accounts(conn)?
        .into_iter()
        .filter(|a| a.provider == provider)
        .collect();
    if let Some(h) = hint {
        if let Some(a) = accounts.iter().find(|a| {
            a.metadata
                .as_ref()
                .and_then(|m| m.get("hint"))
                .and_then(|v| v.as_str())
                == Some(h)
        }) {
            return Ok(a.id.clone());
        }
    }
    if let Some(a) = accounts.first() {
        return Ok(a.id.clone());
    }
    let now = now_iso();
    let id = new_id();
    let meta = hint.map(|h| serde_json::json!({ "hint": h }).to_string());
    conn.execute(
        "INSERT INTO provider_accounts (id, provider, label, auth_mode, status, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'external-app', 'connected', ?4, ?5, ?5)",
        params![id, provider, hint.unwrap_or("Default"), meta, now],
    )?;
    Ok(id)
}

pub fn create_account(
    conn: &Connection,
    provider: &str,
    label: &str,
) -> HubResult<ProviderAccount> {
    if provider != "claude" && provider != "codex" {
        return Err(HubError::new("Unknown provider."));
    }
    let now = now_iso();
    let id = new_id();
    conn.execute(
        "INSERT INTO provider_accounts (id, provider, label, auth_mode, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'external-app', 'connected', ?4, ?4)",
        params![id, provider, label.trim(), now],
    )?;
    Ok(list_accounts(conn)?
        .into_iter()
        .find(|a| a.id == id)
        .expect("inserted"))
}

pub fn rename_account(conn: &Connection, id: &str, label: &str) -> HubResult<()> {
    conn.execute(
        "UPDATE provider_accounts SET label=?2, updated_at=?3 WHERE id=?1",
        params![id, label.trim(), now_iso()],
    )?;
    Ok(())
}

// ───────────────────────────── links ─────────────────────────────

pub fn list_links(conn: &Connection) -> rusqlite::Result<Vec<SessionLink>> {
    let mut st = conn.prepare("SELECT from_id, to_id, kind, created_at FROM session_links")?;
    let rows = st.query_map([], |r| {
        Ok(SessionLink {
            from_id: r.get(0)?,
            to_id: r.get(1)?,
            kind: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn set_link(conn: &Connection, from: &str, to: &str, linked: bool) -> HubResult<()> {
    if from == to {
        return Err(HubError::new("A session can't be linked to itself."));
    }
    // Links are undirected; store them in a canonical order.
    let (a, b) = if from < to { (from, to) } else { (to, from) };
    if linked {
        conn.execute(
            "INSERT OR IGNORE INTO session_links (from_id, to_id, kind, created_at) VALUES (?1, ?2, 'related', ?3)",
            params![a, b, now_iso()],
        )?;
    } else {
        conn.execute(
            "DELETE FROM session_links WHERE from_id = ?1 AND to_id = ?2",
            params![a, b],
        )?;
    }
    Ok(())
}

// ───────────────────────────── scans & settings ─────────────────────────────

pub fn record_scan(
    conn: &Connection,
    started: &str,
    r: &ProviderScanResult,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO scan_runs (adapter, started_at, finished_at, status, found, new, updated, message)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![r.adapter, started, now_iso(), r.status, r.found as i64, r.new as i64, r.updated as i64, r.message],
    )?;
    Ok(())
}

pub fn last_scans(conn: &Connection) -> rusqlite::Result<Vec<ScanRun>> {
    let mut st = conn.prepare(
        "SELECT adapter, finished_at, found, new, updated, status FROM scan_runs
         WHERE id IN (SELECT MAX(id) FROM scan_runs GROUP BY adapter)",
    )?;
    let rows = st.query_map([], |r| {
        Ok(ScanRun {
            adapter: r.get(0)?,
            finished_at: r.get(1)?,
            found: r.get(2)?,
            new: r.get(3)?,
            updated: r.get(4)?,
            status: r.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_settings(conn: &Connection) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut st = conn.prepare("SELECT key, value FROM settings")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, serde_json::from_str(&v).unwrap_or(Value::String(v)));
    }
    Ok(map)
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<Value>> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn set_setting(conn: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

pub fn snapshot(conn: &Connection) -> rusqlite::Result<HubSnapshot> {
    Ok(HubSnapshot {
        projects: list_projects(conn)?,
        sessions: list_sessions(conn)?,
        accounts: list_accounts(conn)?,
        links: list_links(conn)?,
        last_scans: last_scans(conn)?,
        settings: get_settings(conn)?,
        activity: list_events(
            conn,
            &(Utc::now() - chrono::Duration::days(30)).to_rfc3339_opts(SecondsFormat::Millis, true),
            600,
        )?,
    })
}

// ───────────────────────────── demo data ─────────────────────────────

pub fn clear_demo(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE source = 'demo'", [])?;
    conn.execute("DELETE FROM projects WHERE is_demo = 1", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(conn: &Connection, name: &str, root: Option<&str>) -> Project {
        create_project(
            conn,
            ProjectInput {
                name: name.into(),
                root_path: root.map(Into::into),
                icon: None,
                color: None,
                is_demo: false,
            },
        )
        .unwrap()
    }

    #[test]
    fn adopts_the_index_from_the_legacy_folder_once() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(LEGACY_IDENTIFIER);
        std::fs::create_dir_all(&legacy).unwrap();
        {
            let c = open(&legacy.join("hub.sqlite")).unwrap();
            project(&c, "Lumen", None);
        }
        let new_dir = root.path().join("com.hoku.app");
        std::fs::create_dir_all(&new_dir).unwrap();
        assert!(adopt_legacy_index(&new_dir).is_some());
        let c = open(&new_dir.join("hub.sqlite")).unwrap();
        assert_eq!(list_projects(&c).unwrap()[0].name, "Lumen");
        // Never twice, never over an existing index; the legacy file stays.
        assert!(adopt_legacy_index(&new_dir).is_none());
        assert!(legacy.join("hub.sqlite").exists());
    }

    #[test]
    fn slots_are_stable_and_reused() {
        let c = open_in_memory();
        let a = project(&c, "A", None);
        let b = project(&c, "B", None);
        let d = project(&c, "C", None);
        assert_eq!((a.slot, b.slot, d.slot), (1, 2, 3));
        delete_project(&c, &b.id).unwrap();
        // Remaining projects keep their slots; the gap is reused.
        assert_eq!(get_project(&c, &d.id).unwrap().unwrap().slot, 3);
        assert_eq!(project(&c, "D", None).slot, 2);
    }

    #[test]
    fn archiving_keeps_sessions_and_restores_in_place() {
        let c = open_in_memory();
        let p = project(&c, "Lumen", Some("/u/lumen"));
        let d = DiscoveredSession {
            external_id: "s".into(),
            title: "t".into(),
            ..Default::default()
        };
        upsert_discovered(
            &c,
            Provider::Codex,
            "codex-state-db",
            &d,
            Some(p.id.clone()),
            None,
        )
        .unwrap();
        let archived = set_project_archived(&c, &p.id, true).unwrap();
        assert!(archived.archived_at.is_some());
        assert_eq!(archived.slot, p.slot);
        assert_eq!(archived.root_path, p.root_path);
        let s = find_session_by_external(&c, Provider::Codex, "s")
            .unwrap()
            .unwrap();
        assert_eq!(
            s.project_id.as_deref(),
            Some(p.id.as_str()),
            "sessions stay assigned"
        );
        let restored = set_project_archived(&c, &p.id, false).unwrap();
        assert!(restored.archived_at.is_none());
        assert_eq!(restored.slot, p.slot);
    }

    #[test]
    fn deleting_a_project_moves_sessions_to_unsorted() {
        let c = open_in_memory();
        let p = project(&c, "Atlas", None);
        let d = DiscoveredSession {
            external_id: "s".into(),
            title: "t".into(),
            ..Default::default()
        };
        upsert_discovered(
            &c,
            Provider::Codex,
            "codex-state-db",
            &d,
            Some(p.id.clone()),
            None,
        )
        .unwrap();
        let s = find_session_by_external(&c, Provider::Codex, "s")
            .unwrap()
            .unwrap();
        update_session(
            &c,
            &s.id,
            SessionPatch {
                notes: Some(Some("keep me".into())),
                favorite: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        delete_project(&c, &p.id).unwrap();
        let s = get_session(&c, &s.id).unwrap().unwrap();
        assert_eq!(s.project_id, None);
        assert!(!s.project_locked);
        assert_eq!((s.notes.as_deref(), s.favorite), (Some("keep me"), true));
    }

    #[test]
    fn scan_never_overrides_user_fields() {
        let c = open_in_memory();
        let p = project(&c, "Atlas", None);
        let d = DiscoveredSession {
            external_id: "x".into(),
            title: "Scanned".into(),
            ..Default::default()
        };
        upsert_discovered(&c, Provider::Codex, "codex-state-db", &d, None, None).unwrap();
        let s = find_session_by_external(&c, Provider::Codex, "x")
            .unwrap()
            .unwrap();
        update_session(
            &c,
            &s.id,
            SessionPatch {
                title: Some("Mine".into()),
                project_id: Some(Some(p.id.clone())),
                favorite: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let d2 = DiscoveredSession {
            external_id: "x".into(),
            title: "Scanned again".into(),
            ..Default::default()
        };
        upsert_discovered(&c, Provider::Codex, "codex-state-db", &d2, None, None).unwrap();
        let s = get_session(&c, &s.id).unwrap().unwrap();
        assert_eq!(s.title, "Mine");
        assert_eq!(s.project_id.as_deref(), Some(p.id.as_str()));
        assert!(s.favorite);
    }

    #[test]
    fn missing_sessions_are_flagged_not_deleted() {
        let c = open_in_memory();
        let d = DiscoveredSession {
            external_id: "gone".into(),
            title: "t".into(),
            ..Default::default()
        };
        upsert_discovered(
            &c,
            Provider::ClaudeCode,
            "claude-code-transcripts",
            &d,
            None,
            None,
        )
        .unwrap();
        flag_missing(&c, Provider::ClaudeCode, "claude-code-transcripts", &[]).unwrap();
        let s = find_session_by_external(&c, Provider::ClaudeCode, "gone")
            .unwrap()
            .unwrap();
        assert!(s.source_missing);
    }

    #[test]
    fn migrates_a_v1_database_without_losing_rows() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(&format!(
            "BEGIN; {}; PRAGMA user_version = 1; COMMIT;",
            MIGRATIONS[0]
        ))
        .unwrap();
        c.execute_batch(
            "INSERT INTO sessions (id, provider, title, activity_state, source, created_at, updated_at)
               VALUES ('a','codex','Real','active','codex-state-db','t','t'), ('b','claude','Demo','active','demo','t','t');",
        )
        .unwrap();
        migrate(&c).unwrap();
        let v: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        let real = get_session(&c, "a").unwrap().unwrap();
        // Real sessions start unevaluated; the monitor owns their state from here.
        assert_eq!(
            (real.runtime.state, real.runtime.source.as_deref()),
            (RuntimeState::Unknown, None)
        );
        assert_eq!(
            get_session(&c, "b").unwrap().unwrap().runtime.state,
            RuntimeState::Working
        );
    }

    #[test]
    fn events_cascade_with_their_session() {
        let c = open_in_memory();
        let d = DiscoveredSession {
            external_id: "x".into(),
            title: "t".into(),
            ..Default::default()
        };
        upsert_discovered(&c, Provider::Codex, "codex-state-db", &d, None, None).unwrap();
        let s = find_session_by_external(&c, Provider::Codex, "x")
            .unwrap()
            .unwrap();
        let e = ActivityEvent {
            id: "e1".into(),
            session_id: s.id.clone(),
            event_type: "became_ready".into(),
            provider: Provider::Codex,
            timestamp: now_iso(),
            title: Some("t".into()),
            from_state: Some(RuntimeState::Working),
            to_state: Some(RuntimeState::Ready),
            reason: None,
            metadata: None,
        };
        insert_event(&c, &e).unwrap();
        assert_eq!(snapshot(&c).unwrap().activity.len(), 1);
        delete_session(&c, &s.id).unwrap();
        assert!(snapshot(&c).unwrap().activity.is_empty());
    }

    #[test]
    fn duplicate_manual_add_is_rejected() {
        let c = open_in_memory();
        let input = || ManualSessionInput {
            provider: Provider::Claude,
            external_id: Some("abc".into()),
            title: "Chat".into(),
            project_id: None,
            provider_account_id: None,
            working_directory: None,
            deep_link: None,
            source_url: None,
            notes: None,
            source: "manual".into(),
            metadata: None,
            last_activity_at: None,
            runtime: None,
            favorite: false,
        };
        insert_manual_session(&c, input()).unwrap();
        assert!(insert_manual_session(&c, input()).is_err());
    }
}
