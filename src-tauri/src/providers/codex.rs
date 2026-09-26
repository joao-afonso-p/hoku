//! Codex Desktop: the thread index in `~/.codex/state_<n>.sqlite`, opened strictly read-only.
//! See docs/provider-discovery.md §3.

use super::{
    app_running, file_stamp, ms_to_iso, now_ms, read_tail, text, Observation, RuntimeCapabilities,
    RuntimeProbe, RuntimeTarget, ScanOutcome, SessionAdapter,
};
use crate::association::{repository_root, strip_agent_worktree};
use crate::models::{Confidence, DiscoveredSession, HubError, ProjectHint, Provider, RuntimeState};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const SOURCE: &str = "codex-rollout";
/// Threads updated this recently get their rollout tail read even without a writer lock.
const RECENT_WINDOW_MS: i64 = 12 * 60 * 60 * 1000;
/// An escalated command still pending after this long is waiting on the user, not the sandbox.
const APPROVAL_GRACE_MS: i64 = 4_000;
const APP_EXECUTABLE: &str = "ChatGPT.app/Contents/MacOS/ChatGPT";

pub struct CodexAdapter {
    root: PathBuf,
    tails: Mutex<HashMap<PathBuf, ((u64, SystemTime), RolloutTail)>>,
}

impl CodexAdapter {
    pub fn new(root: PathBuf) -> Self {
        CodexAdapter {
            root,
            tails: Mutex::new(HashMap::new()),
        }
    }

    fn tail_of(&self, path: &Path) -> Option<RolloutTail> {
        let stamp = file_stamp(path)?;
        let mut cache = self.tails.lock().expect("tails");
        if let Some((s, t)) = cache.get(path) {
            if *s == stamp {
                return Some(t.clone());
            }
        }
        let tail = parse_rollout_tail(&read_tail(path, 256 * 1024)?);
        cache.insert(path.to_path_buf(), (stamp, tail.clone()));
        Some(tail)
    }

    /// Highest-numbered `state_<n>.sqlite` — the suffix is Codex's schema generation.
    pub fn state_db(&self) -> Option<PathBuf> {
        let entries = std::fs::read_dir(&self.root).ok()?;
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let n: u32 = name
                    .strip_prefix("state_")?
                    .strip_suffix(".sqlite")?
                    .parse()
                    .ok()?;
                Some((n, e.path()))
            })
            .max_by_key(|(n, _)| *n)
            .map(|(_, p)| p)
    }

    fn open_ro(path: &Path) -> Result<Connection, HubError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| HubError::with_detail("Codex's thread index couldn't be opened.", e))?;
        conn.busy_timeout(std::time::Duration::from_millis(1500))
            .ok();
        conn.pragma_update(None, "query_only", true).ok();
        Ok(conn)
    }

    fn locked_threads(&self) -> HashSet<String> {
        let dir = self.root.join("thread-writer-locks");
        std::fs::read_dir(dir)
            .map(|it| {
                it.flatten()
                    .filter_map(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .strip_suffix(".lock")
                            .map(str::to_string)
                    })
                    .filter(|n| !n.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(mut st) = conn.prepare(&format!("PRAGMA table_info({table})")) {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(1)) {
            out.extend(rows.flatten());
        }
    }
    out
}

// ───────────────────────────── runtime ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Turn {
    #[default]
    Unknown,
    Started,
    Complete,
    Aborted,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingCall {
    pub call_id: String,
    pub name: String,
    /// The model asked to run outside the sandbox (`sandbox_permissions: "require_escalated"`).
    pub escalated: bool,
    /// The question shown with an approval, or the first `request_user_input` question.
    pub prompt: Option<String>,
    pub at: Option<String>,
}

/// What the end of a Codex rollout (`sessions/…/rollout-*.jsonl`) says about the thread.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RolloutTail {
    pub turn: Turn,
    pub turn_at: Option<String>,
    pub last_at: Option<String>,
    pub pending: Option<PendingCall>,
}

fn string_field(raw: &str, key: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let mut m = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("re cache");
    let re = m.entry(key.to_string()).or_insert_with(|| {
        Regex::new(&format!(
            r#"\\?"{key}\\?"\s*:\s*\\?"((?:[^"\\]|\\[^"])*)\\?""#
        ))
        .unwrap()
    });
    re.captures(raw)
        .map(|c| c[1].replace("\\n", " ").replace("\\", ""))
}

pub fn parse_rollout_tail(raw: &str) -> RolloutTail {
    let mut t = RolloutTail::default();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let at = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(str::to_string);
        if at.is_some() {
            t.last_at = at.clone();
        }
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let Some(p) = v.get("payload") else { continue };
        let ptype = p.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match (kind, ptype) {
            ("event_msg", "task_started") => {
                t.turn = Turn::Started;
                t.turn_at = at;
                t.pending = None;
            }
            ("event_msg", "task_complete") => {
                t.turn = Turn::Complete;
                t.turn_at = at;
                t.pending = None;
            }
            ("event_msg", "turn_aborted") => {
                t.turn = Turn::Aborted;
                t.turn_at = at;
                t.pending = None;
            }
            ("event_msg", "error") => {
                t.turn = Turn::Failed(
                    p.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown error")
                        .to_string(),
                );
                t.turn_at = at;
            }
            ("response_item", "function_call" | "custom_tool_call") => {
                if matches!(t.turn, Turn::Failed(_)) {
                    t.turn = Turn::Started; // the turn carried on after a retried error
                }
                let args = p
                    .get("arguments")
                    .or_else(|| p.get("input"))
                    .and_then(|a| a.as_str())
                    .unwrap_or("");
                let name = p
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let escalated = args.contains("require_escalated")
                    || args.contains("with_escalated_permissions\\\":true")
                    || args.contains("with_escalated_permissions\":true");
                let prompt = if name == "request_user_input" {
                    string_field(args, "question")
                } else if escalated {
                    string_field(args, "justification")
                } else {
                    None
                };
                t.pending = Some(PendingCall {
                    call_id: p
                        .get("call_id")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name,
                    escalated,
                    prompt,
                    at,
                });
            }
            ("response_item", "function_call_output" | "custom_tool_call_output") => {
                let id = p.get("call_id").and_then(|c| c.as_str()).unwrap_or("");
                if t.pending.as_ref().map(|c| c.call_id == id).unwrap_or(false) {
                    t.pending = None;
                }
            }
            _ => {}
        }
    }
    t
}

fn iso_ms(iso: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso?)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Map one thread onto the normalized model. `locked` = Codex holds the thread open.
pub fn observe_thread(
    tail: Option<&RolloutTail>,
    locked: bool,
    approval_mode: Option<&str>,
    now: i64,
) -> Observation {
    let offline = || {
        Observation::new(RuntimeState::Offline, Confidence::Medium, SOURCE)
            .reason("Not open in Codex")
    };
    let Some(t) = tail else {
        return if locked {
            Observation::new(RuntimeState::Idle, Confidence::Low, SOURCE).reason("Open in Codex")
        } else {
            offline()
        };
    };
    let quiet = iso_ms(t.last_at.as_deref())
        .map(|ms| now - ms)
        .unwrap_or(i64::MAX);
    match &t.turn {
        Turn::Started | Turn::Unknown if t.turn == Turn::Started || quiet < 120_000 => {
            if !locked && quiet > 60_000 {
                return Observation::new(RuntimeState::Offline, Confidence::Medium, SOURCE)
                    .reason("Turn stopped · thread closed");
            }
            if let Some(c) = &t.pending {
                let waited = iso_ms(c.at.as_deref()).map(|ms| now - ms).unwrap_or(0);
                if c.name == "request_user_input" {
                    return Observation::new(RuntimeState::NeedsInput, Confidence::Medium, SOURCE)
                        .reason("Asked a question")
                        .detail(c.prompt.clone())
                        .since(c.at.clone());
                }
                if c.escalated
                    && approval_mode != Some("never")
                    && waited > APPROVAL_GRACE_MS
                    && quiet > APPROVAL_GRACE_MS
                {
                    return Observation::new(RuntimeState::NeedsInput, Confidence::Medium, SOURCE)
                        .reason("Waiting for approval")
                        .detail(c.prompt.clone())
                        .since(c.at.clone());
                }
                return Observation::new(RuntimeState::Working, Confidence::Medium, SOURCE)
                    .reason(format!("Running {}", c.name))
                    .since(t.turn_at.clone())
                    .activity(t.last_at.clone());
            }
            Observation::new(RuntimeState::Working, Confidence::Medium, SOURCE)
                .reason("Turn in progress")
                .since(t.turn_at.clone())
                .activity(t.last_at.clone())
        }
        Turn::Failed(msg) => Observation::new(RuntimeState::Error, Confidence::Medium, SOURCE)
            .reason("Turn failed")
            .detail(Some(msg.clone()))
            .since(t.turn_at.clone()),
        _ if !locked => offline(),
        Turn::Complete => Observation::new(RuntimeState::Ready, Confidence::Medium, SOURCE)
            .reason("Finished its turn")
            .since(t.turn_at.clone()),
        Turn::Aborted => Observation::new(RuntimeState::Idle, Confidence::Medium, SOURCE)
            .reason("Turn interrupted")
            .since(t.turn_at.clone()),
        _ => Observation::new(RuntimeState::Idle, Confidence::Low, SOURCE).reason("Open in Codex"),
    }
}

/// Map Codex's named palette onto our muted accents.
fn codex_color(name: &str) -> Option<String> {
    let hex = match name {
        "red" => "#d98a7e",
        "orange" => "#d9a066",
        "yellow" => "#d6c27a",
        "green" => "#8fbf8a",
        "teal" => "#7fbfb4",
        "blue" => "#8ea8e0",
        "purple" => "#b39ae0",
        "pink" => "#d994b8",
        _ => return None,
    };
    Some(hex.into())
}

/// Drop `user:token@` from a URL-style git origin so credentials never reach the index.
/// scp-style origins (`git@host:org/repo`) carry no secret and are kept as-is.
fn strip_userinfo(origin: &str) -> String {
    if let Some(i) = origin.find("://") {
        let (scheme, rest) = origin.split_at(i + 3);
        let authority = rest.find('/').map_or(rest, |end| &rest[..end]);
        if let Some(at) = authority.rfind('@') {
            return format!("{scheme}{}", &rest[at + 1..]);
        }
    }
    origin.to_string()
}

#[derive(Debug)]
pub struct ThreadRow {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub name: Option<String>,
    pub first_user_message: Option<String>,
    pub updated_ms: i64,
    pub branch: Option<String>,
    pub origin: Option<String>,
    pub model: Option<String>,
    pub tokens: Option<i64>,
    pub pinned: bool,
    pub thread_source: Option<String>,
}

pub fn thread_title(t: &ThreadRow) -> String {
    t.name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| text::truncate(s, 64))
        .or_else(|| text::title_from_prompt(&t.title, 64))
        .or_else(|| {
            t.first_user_message
                .as_deref()
                .and_then(|m| text::title_from_prompt(m, 64))
        })
        .unwrap_or_else(|| "Untitled thread".into())
}

impl CodexAdapter {
    fn read_threads(&self, conn: &Connection) -> Result<Vec<ThreadRow>, HubError> {
        let cols = columns(conn, "threads");
        for required in ["id", "cwd", "title", "updated_at"] {
            if !cols.contains(required) {
                return Err(HubError::with_detail(
                    "Codex's thread index has a format Hoku doesn't recognise yet.",
                    format!("missing column threads.{required}"),
                ));
            }
        }
        let opt = |c: &str, fallback: &str| {
            if cols.contains(c) {
                c.to_string()
            } else {
                fallback.to_string()
            }
        };
        let updated = if cols.contains("recency_at_ms") {
            "MAX(COALESCE(recency_at_ms,0), COALESCE(updated_at_ms, updated_at*1000))".to_string()
        } else if cols.contains("updated_at_ms") {
            "COALESCE(updated_at_ms, updated_at*1000)".to_string()
        } else {
            "updated_at*1000".to_string()
        };
        let mut filters = vec![];
        if cols.contains("archived") {
            filters.push("archived = 0".to_string());
        }
        if cols.contains("thread_source") {
            filters.push("COALESCE(thread_source,'') NOT IN ('automation','subagent')".to_string());
        }
        if cols.contains("source") {
            filters.push("source NOT LIKE '%subagent%'".to_string());
        }
        let where_clause = if filters.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", filters.join(" AND "))
        };
        let sql = format!(
            "SELECT id, cwd, title, {name}, {fum}, {updated}, {branch}, {origin}, {model}, {tokens}, {pinned}, {tsrc}
             FROM threads {where_clause} ORDER BY 6 DESC",
            name = opt("name", "NULL"),
            fum = opt("first_user_message", "NULL"),
            branch = opt("git_branch", "NULL"),
            origin = opt("git_origin_url", "NULL"),
            model = opt("model", "NULL"),
            tokens = opt("tokens_used", "NULL"),
            pinned = opt("is_pinned", "0"),
            tsrc = opt("thread_source", "NULL"),
        );
        let mut st = conn
            .prepare(&sql)
            .map_err(|e| HubError::with_detail("Codex's thread index couldn't be queried.", e))?;
        let rows = st
            .query_map([], |r| {
                Ok(ThreadRow {
                    id: r.get(0)?,
                    cwd: r.get(1)?,
                    title: r.get(2)?,
                    name: r.get(3)?,
                    first_user_message: r.get(4)?,
                    updated_ms: r.get(5)?,
                    branch: r.get(6)?,
                    origin: r.get(7)?,
                    model: r.get(8)?,
                    tokens: r.get(9)?,
                    pinned: r.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
                    thread_source: r.get(11)?,
                })
            })
            .map_err(|e| HubError::with_detail("Codex's thread index couldn't be queried.", e))?;
        Ok(rows.flatten().collect())
    }
}

impl SessionAdapter for CodexAdapter {
    fn key(&self) -> &'static str {
        "codex-state-db"
    }
    fn provider(&self) -> Provider {
        Provider::Codex
    }
    fn label(&self) -> &'static str {
        "Codex"
    }

    fn scan(&self) -> Result<ScanOutcome, HubError> {
        let Some(db) = self.state_db() else {
            return Ok(ScanOutcome::Unavailable(
                "No Codex threads were found on this Mac (~/.codex has no thread index).".into(),
            ));
        };
        let conn = Self::open_ro(&db)?;
        let threads = self.read_threads(&conn)?;
        let mut repo_cache: HashMap<String, Option<String>> = HashMap::new();

        let out = threads
            .into_iter()
            .map(|t| {
                let repo = repo_cache
                    .entry(t.cwd.clone())
                    .or_insert_with(|| {
                        repository_root(&t.cwd)
                            .or_else(|| Some(strip_agent_worktree(&t.cwd).to_string()))
                    })
                    .clone();
                let mut meta = serde_json::Map::new();
                meta.insert("stateDb".into(), json!(db.to_string_lossy()));
                if let Some(m) = t
                    .first_user_message
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .or(Some(t.title.as_str()))
                {
                    meta.insert("firstPrompt".into(), json!(text::preview(m)));
                }
                if let Some(o) = &t.origin {
                    meta.insert("gitOrigin".into(), json!(strip_userinfo(o)));
                }
                if let Some(m) = &t.model {
                    meta.insert("model".into(), json!(m));
                }
                if let Some(n) = t.tokens {
                    meta.insert("tokensUsed".into(), json!(n));
                }
                if t.pinned {
                    meta.insert("pinnedInCodex".into(), json!(true));
                }
                if let Some(s) = &t.thread_source {
                    meta.insert("threadSource".into(), json!(s));
                }
                DiscoveredSession {
                    external_id: t.id.clone(),
                    title: thread_title(&t),
                    working_directory: Some(t.cwd.clone()),
                    repository: repo,
                    branch: t.branch.clone().filter(|b| !b.is_empty()),
                    deep_link: Some(format!("codex://threads/{}", t.id)),
                    source_url: None,
                    last_activity_at: ms_to_iso(t.updated_ms),
                    account_hint: None,
                    metadata: meta,
                }
            })
            .collect();
        Ok(ScanOutcome::Found(out))
    }

    fn project_hints(&self) -> Vec<ProjectHint> {
        let Some(db) = self.state_db() else {
            return vec![];
        };
        let Ok(conn) = Self::open_ro(&db) else {
            return vec![];
        };
        let sql = "SELECT p.name, r.path, p.metadata FROM projects p JOIN project_roots r ON r.project_id = p.id
                   WHERE r.position = 0 ORDER BY p.position";
        let Ok(mut st) = conn.prepare(sql) else {
            return vec![];
        };
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        });
        let Ok(rows) = rows else { return vec![] };
        rows.flatten()
            .map(|(name, path, meta)| {
                let color = meta
                    .and_then(|m| serde_json::from_str::<Value>(&m).ok())
                    .and_then(|m| {
                        m.get("appearance.color")
                            .and_then(|c| c.as_str())
                            .and_then(codex_color)
                    });
                ProjectHint {
                    name,
                    root_path: path,
                    color,
                    source: "Codex project".into(),
                }
            })
            .collect()
    }

    fn runtime(&self, targets: &[RuntimeTarget]) -> Option<RuntimeProbe> {
        let db = self.state_db()?;
        if !app_running(APP_EXECUTABLE) {
            return Some(RuntimeProbe {
                observations: HashMap::new(),
                fallback: Observation::new(RuntimeState::Offline, Confidence::High, SOURCE)
                    .reason("Codex isn't running"),
                unindexed_live: vec![],
            });
        }
        let conn = Self::open_ro(&db).ok()?;
        let locks = self.locked_threads();
        let now = now_ms();
        let cols = columns(&conn, "threads");
        let updated = if cols.contains("updated_at_ms") {
            "COALESCE(updated_at_ms, updated_at*1000)"
        } else {
            "updated_at*1000"
        };
        let approval = if cols.contains("approval_mode") {
            "approval_mode"
        } else {
            "NULL"
        };
        let rollout = if cols.contains("rollout_path") {
            "rollout_path"
        } else {
            "NULL"
        };
        let sql = format!(
            "SELECT id, {rollout}, {approval}, {updated} FROM threads WHERE {updated} > ?1"
        );
        let mut candidates: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        if let Ok(mut st) = conn.prepare(&sql) {
            if let Ok(rows) = st.query_map([now - RECENT_WINDOW_MS], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            }) {
                for (id, path, mode) in rows.flatten() {
                    candidates.insert(id, (path, mode));
                }
            }
        }
        // Locked threads can be older than the window; look them up individually.
        let one = format!("SELECT {rollout}, {approval} FROM threads WHERE id = ?1");
        let missing: Vec<&String> = locks
            .iter()
            .filter(|id| !candidates.contains_key(*id))
            .collect();
        for id in missing {
            if let Ok(row) = conn.query_row(&one, [id], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            }) {
                candidates.insert(id.clone(), row);
            }
        }
        let mut observations = HashMap::new();
        for t in targets {
            let Some((path, mode)) = candidates.get(t.external_id) else {
                continue;
            };
            let tail = path.as_deref().map(Path::new).and_then(|p| self.tail_of(p));
            observations.insert(
                t.external_id.to_string(),
                observe_thread(
                    tail.as_ref(),
                    locks.contains(t.external_id),
                    mode.as_deref(),
                    now,
                ),
            );
        }
        Some(RuntimeProbe {
            observations,
            fallback: Observation::new(RuntimeState::Offline, Confidence::Medium, SOURCE)
                .reason("Not open in Codex"),
            unindexed_live: vec![],
        })
    }

    fn runtime_capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities {
            live_status: "partial",
            working: "full",
            needs_input: "partial",
            ready: "full",
            error: "partial",
            detail: "Inferred from the thread's rollout and writer locks. Approvals are detected from escalated commands still pending",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_origin_credentials_are_stripped() {
        assert_eq!(
            strip_userinfo("https://user:ghp_secret@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            strip_userinfo("https://github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(strip_userinfo("git@x:y.git"), "git@x:y.git");
        assert_eq!(
            strip_userinfo("https://github.com/o/r@v1"),
            "https://github.com/o/r@v1"
        );
    }

    fn fixture() -> (tempfile::TempDir, CodexAdapter) {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state_5.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER NOT NULL,
               source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
               git_branch TEXT, git_origin_url TEXT, name TEXT, thread_source TEXT, updated_at_ms INTEGER,
               first_user_message TEXT NOT NULL DEFAULT '', is_pinned INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER);
             CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
             INSERT INTO threads VALUES ('t1','',0,100,'vscode','/u/atlas','Plan backup\n\nmore',0,'main','git@x:y.git','Backup / DR','user',100000,'',1);
             INSERT INTO threads VALUES ('t2','',0,100,'vscode','/u/obsidian','Classify notes',0,NULL,NULL,NULL,'automation',100000,'',0);
             INSERT INTO threads VALUES ('t3','',0,100,'vscode','/u/atlas','Old',1,NULL,NULL,NULL,'user',100000,'',0);
             INSERT INTO threads VALUES ('t4','',0,100,'{\"subagent\":{}}','/u/atlas','Sub',0,NULL,NULL,NULL,NULL,100000,'',0);
             INSERT INTO threads VALUES ('t5','',0,100,'vscode','/u/site','# Files pasted\n\nRedesign mobile nav',0,NULL,NULL,'','user',200000,'',0);
             INSERT INTO projects VALUES ('p1','Atlas','{\"appearance.color\":\"green\"}',0);
             INSERT INTO project_roots VALUES ('p1',0,'/u/atlas');",
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("thread-writer-locks")).unwrap();
        std::fs::write(dir.path().join("thread-writer-locks/t1.lock"), "").unwrap();
        let adapter = CodexAdapter::new(dir.path().to_path_buf());
        (dir, adapter)
    }

    #[test]
    fn scans_user_threads_only() {
        let (_d, a) = fixture();
        let ScanOutcome::Found(found) = a.scan().unwrap() else {
            panic!()
        };
        let ids: Vec<_> = found.iter().map(|s| s.external_id.as_str()).collect();
        assert_eq!(ids, vec!["t5", "t1"]);
        let t1 = found.iter().find(|s| s.external_id == "t1").unwrap();
        assert_eq!(t1.title, "Backup / DR");
        assert_eq!(t1.deep_link.as_deref(), Some("codex://threads/t1"));
        assert_eq!(t1.branch.as_deref(), Some("main"));
        let t5 = found.iter().find(|s| s.external_id == "t5").unwrap();
        assert_eq!(t5.title, "Redesign mobile nav");
    }

    #[test]
    fn reads_project_hints() {
        let (_d, a) = fixture();
        let hints = a.project_hints();
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].name, "Atlas");
        assert_eq!(hints[0].color.as_deref(), Some("#8fbf8a"));
    }

    #[test]
    fn never_writes_to_the_codex_db() {
        let (d, a) = fixture();
        let conn = CodexAdapter::open_ro(&d.path().join("state_5.sqlite")).unwrap();
        assert!(conn.execute("DELETE FROM threads", []).is_err());
        drop(a);
    }

    fn line(ts: &str, kind: &str, payload: Value) -> String {
        json!({ "timestamp": ts, "type": kind, "payload": payload }).to_string() + "\n"
    }
    const NOW: &str = "2026-09-24T12:00:00.000Z";
    fn now() -> i64 {
        iso_ms(Some(NOW)).unwrap()
    }

    #[test]
    fn rollout_turns_map_to_runtime_states() {
        let started = line(
            "2026-09-24T11:59:50.000Z",
            "event_msg",
            json!({"type":"task_started"}),
        );
        let t = parse_rollout_tail(&started);
        let o = observe_thread(Some(&t), true, Some("on-request"), now());
        assert_eq!(
            (o.state, o.confidence),
            (RuntimeState::Working, Confidence::Medium)
        );

        let done = started.clone()
            + &line(
                "2026-09-24T11:59:55.000Z",
                "event_msg",
                json!({"type":"task_complete"}),
            );
        let o = observe_thread(
            Some(&parse_rollout_tail(&done)),
            true,
            Some("on-request"),
            now(),
        );
        assert_eq!(o.state, RuntimeState::Ready);
        assert!(!o.action_required);
        // Same thread, no longer held open by Codex.
        assert_eq!(
            observe_thread(Some(&parse_rollout_tail(&done)), false, None, now()).state,
            RuntimeState::Offline
        );

        let aborted = started.clone()
            + &line(
                "2026-09-24T11:59:55.000Z",
                "event_msg",
                json!({"type":"turn_aborted"}),
            );
        assert_eq!(
            observe_thread(Some(&parse_rollout_tail(&aborted)), true, None, now()).state,
            RuntimeState::Idle
        );

        let failed = started.clone()
            + &line(
                "2026-09-24T11:59:55.000Z",
                "event_msg",
                json!({"type":"error","message":"stream disconnected"}),
            );
        let o = observe_thread(Some(&parse_rollout_tail(&failed)), true, None, now());
        assert_eq!(
            (o.state, o.detail.as_deref()),
            (RuntimeState::Error, Some("stream disconnected"))
        );
    }

    #[test]
    fn pending_escalated_command_is_an_approval() {
        // Mirrors a real rollout: a JS `exec` wrapper whose input carries the escalation request.
        let input = r#"const r = await tools.exec_command({cmd:"ssh host 'ls'","sandbox_permissions":"require_escalated","justification":"Allow a read-only check on the server?"});"#;
        let raw = line(
            "2026-09-24T11:00:00.000Z",
            "event_msg",
            json!({"type":"task_started"}),
        ) + &line(
            "2026-09-24T11:00:05.000Z",
            "response_item",
            json!({"type":"custom_tool_call","name":"exec","call_id":"c1","input": input}),
        );
        let o = observe_thread(
            Some(&parse_rollout_tail(&raw)),
            true,
            Some("on-request"),
            now(),
        );
        assert_eq!(o.state, RuntimeState::NeedsInput);
        assert_eq!(o.reason.as_deref(), Some("Waiting for approval"));
        assert_eq!(
            o.detail.as_deref(),
            Some("Allow a read-only check on the server?")
        );
        assert_eq!(o.since.as_deref(), Some("2026-09-24T11:00:05.000Z"));
        // With approvals off, the same call is just work.
        assert_eq!(
            observe_thread(Some(&parse_rollout_tail(&raw)), true, Some("never"), now()).state,
            RuntimeState::Working
        );
        // Once the output lands the thread is working again.
        let answered = raw
            + &line(
                "2026-09-24T11:59:59.000Z",
                "response_item",
                json!({"type":"custom_tool_call_output","call_id":"c1"}),
            );
        assert_eq!(
            observe_thread(
                Some(&parse_rollout_tail(&answered)),
                true,
                Some("on-request"),
                now()
            )
            .state,
            RuntimeState::Working
        );
    }

    #[test]
    fn request_user_input_is_a_question() {
        let args =
            json!({"questions":[{"id":"q","question":"Which test framework?","options":[]}]})
                .to_string();
        let raw = line(
            "2026-09-24T11:59:00.000Z",
            "event_msg",
            json!({"type":"task_started"}),
        ) + &line(
            "2026-09-24T11:59:01.000Z",
            "response_item",
            json!({"type":"function_call","name":"request_user_input","call_id":"q1","arguments": args}),
        );
        let o = observe_thread(Some(&parse_rollout_tail(&raw)), true, None, now());
        assert_eq!(
            (o.state, o.reason.as_deref(), o.detail.as_deref()),
            (
                RuntimeState::NeedsInput,
                Some("Asked a question"),
                Some("Which test framework?")
            )
        );
    }

    #[test]
    fn missing_codex_is_unavailable_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let a = CodexAdapter::new(dir.path().join("nope"));
        assert!(matches!(a.scan().unwrap(), ScanOutcome::Unavailable(_)));
    }
}
