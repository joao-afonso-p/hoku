//! Claude Code: transcripts in `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, live sessions in
//! `~/.claude/sessions/<pid>.json`. See docs/provider-discovery.md §2.

use super::{
    file_stamp, ms_to_iso, pid_alive, read_tail, system_time_iso, text, Observation,
    RuntimeCapabilities, RuntimeProbe, RuntimeTarget, ScanOutcome, SessionAdapter,
};
use crate::association::{repository_root, strip_agent_worktree};
use crate::models::{Confidence, DiscoveredSession, HubError, Provider, RuntimeState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const SOURCE: &str = "claude-code-registry";

pub struct ClaudeCodeAdapter {
    root: PathBuf,
    /// Parsed transcript tails, re-read only when the file changes.
    tails: Mutex<HashMap<PathBuf, ((u64, SystemTime), TranscriptTail)>>,
}

impl ClaudeCodeAdapter {
    pub fn new(root: PathBuf) -> Self {
        ClaudeCodeAdapter {
            root,
            tails: Mutex::new(HashMap::new()),
        }
    }

    fn tail_of(&self, path: &Path) -> Option<(TranscriptTail, SystemTime)> {
        let stamp = file_stamp(path)?;
        let mut cache = self.tails.lock().expect("tails");
        if let Some((s, t)) = cache.get(path) {
            if *s == stamp {
                return Some((t.clone(), stamp.1));
            }
        }
        let tail = parse_transcript_tail(&read_tail(path, 256 * 1024)?);
        cache.insert(path.to_path_buf(), (stamp, tail.clone()));
        Some((tail, stamp.1))
    }
}

/// One entry of the live-session registry. Unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub pid: i64,
    pub session_id: String,
    pub cwd: Option<String>,
    pub kind: Option<String>,
    pub job_id: Option<String>,
    pub status: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<String>,
    #[serde(default)]
    pub spare: bool,
    /// Set by Claude Code while `status` is "waiting": "permission prompt", "input needed",
    /// "dialog open", "sandbox request", "worker request", "goal proposal".
    pub waiting_for: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub status_updated_at: Option<i64>,
}

impl LiveSession {
    pub fn is_background(&self) -> bool {
        self.kind.as_deref() == Some("bg")
    }
}

// ───────────────────────────── runtime ─────────────────────────────

/// Tools that always stop for the user: a question, or the plan-approval dialog.
const ASKS_USER: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

/// A tool the assistant called that hasn't returned yet.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingTool {
    pub id: Option<String>,
    pub name: String,
    /// For AskUserQuestion: the first question, as a preview.
    pub question: Option<String>,
    pub at: Option<String>,
}

/// What the end of a transcript says about the current turn.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptTail {
    /// Tools called and not yet returned, in call order. Parallel calls return one by one, so
    /// each result settles only its own call.
    pub pending: Vec<PendingTool>,
    /// The turn ended on an API error: (kind, message, timestamp).
    pub api_error: Option<(String, String, Option<String>)>,
    pub interrupted: bool,
}

impl TranscriptTail {
    /// The latest pending tool.
    pub fn pending_tool(&self) -> Option<&str> {
        self.pending.last().map(|t| t.name.as_str())
    }
    /// A pending tool that is waiting for the user whatever else is going on.
    pub fn asking(&self) -> Option<&PendingTool> {
        self.pending
            .iter()
            .find(|t| ASKS_USER.contains(&t.name.as_str()))
    }
}

fn content_blocks(v: &Value) -> Vec<&Value> {
    match v.get("message").and_then(|m| m.get("content")) {
        Some(Value::Array(a)) => a.iter().collect(),
        _ => vec![],
    }
}

pub fn parse_transcript_tail(raw: &str) -> TranscriptTail {
    let mut t = TranscriptTail::default();
    for line in raw.lines() {
        let is_user = line.contains("\"type\":\"user\"");
        if !is_user && !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain")
            .and_then(|b| b.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let blocks = content_blocks(&v);
        if kind == "assistant" {
            if v.get("isApiErrorMessage")
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
            {
                let error = v
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let msg = blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|x| x.as_str()))
                    .collect::<Vec<_>>()
                    .join(" ");
                let at = v
                    .get("timestamp")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                t.api_error = Some((error, msg, at));
                t.pending.clear();
                continue;
            }
            t.api_error = None;
            t.interrupted = false;
            // Claude Code writes each content block of a message as its own line, so parallel
            // calls arrive as consecutive tool_use lines.
            let tools: Vec<&&Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|x| x.as_str()) == Some("tool_use"))
                .collect();
            if tools.is_empty() {
                if !blocks.is_empty() {
                    t.pending.clear();
                }
                continue;
            }
            let at = v
                .get("timestamp")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            for tool in tools {
                let id = tool.get("id").and_then(|x| x.as_str()).map(str::to_string);
                let name = tool
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let question = (name == "AskUserQuestion")
                    .then(|| {
                        tool.pointer("/input/questions/0/question")
                            .and_then(|q| q.as_str())
                            .map(str::to_string)
                    })
                    .flatten();
                t.pending.retain(|p| id.is_none() || p.id != id);
                t.pending.push(PendingTool {
                    id,
                    name,
                    question,
                    at: at.clone(),
                });
            }
        } else {
            let results: Vec<Option<&str>> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|x| x.as_str()) == Some("tool_result"))
                .map(|b| b.get("tool_use_id").and_then(|x| x.as_str()))
                .collect();
            if !results.is_empty() {
                if results.iter().any(Option::is_none) {
                    t.pending.clear();
                } else {
                    t.pending
                        .retain(|p| p.id.is_some() && !results.contains(&p.id.as_deref()));
                }
                continue;
            }
            if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
                continue;
            }
            let text = match v.pointer("/message/content") {
                Some(Value::String(s)) => s.clone(),
                _ => blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|x| x.as_str()))
                    .collect::<Vec<_>>()
                    .join(" "),
            };
            t.interrupted = text.trim_start().starts_with("[Request interrupted");
            t.api_error = None;
            t.pending.clear();
        }
    }
    t
}

fn asking_reason(tool: &PendingTool) -> (&'static str, Option<String>) {
    if tool.name == "AskUserQuestion" {
        ("Asked a question", tool.question.clone())
    } else {
        ("Plan needs approval", None)
    }
}

fn waiting_reason(
    waiting_for: Option<&str>,
    tail: Option<&TranscriptTail>,
) -> (&'static str, Option<String>) {
    if let Some(asking) = tail.and_then(|t| t.asking()) {
        return asking_reason(asking);
    }
    let tool = tail.and_then(|t| t.pending_tool());
    match (waiting_for, tool) {
        (Some("permission prompt") | None, Some(tool)) => {
            ("Waiting for permission", Some(tool.to_string()))
        }
        (Some("permission prompt"), None) => ("Waiting for permission", None),
        (Some("input needed"), _) => ("Needs input", None),
        (Some("dialog open"), _) => ("Needs confirmation", None),
        (Some("sandbox request"), _) => ("Sandbox access requested", None),
        (Some("worker request"), _) => ("A worker needs approval", None),
        (Some("goal proposal"), _) => ("Proposed a goal", None),
        (Some(other), _) => ("Waiting for you", Some(other.to_string())),
        (None, None) => ("Waiting for you", None),
    }
}

/// Map one live registry entry (+ transcript tail) onto the normalized model.
pub fn observe_live(
    l: &LiveSession,
    tail: Option<&TranscriptTail>,
    transcript_at: Option<String>,
) -> Observation {
    let changed_ms = l.status_updated_at.or(l.updated_at);
    let changed = changed_ms.and_then(ms_to_iso);
    let activity = match (transcript_at, changed.clone()) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    match l.status.as_deref() {
        Some("busy") => {
            // A question or plan approval waits for the user even if the registry hasn't caught
            // up yet (or this Claude Code build doesn't publish "waiting"). Other pending tools
            // are work: most run without asking, and the registry says when one does.
            if let Some(asking) = tail.and_then(|t| t.asking()) {
                let (reason, detail) = asking_reason(asking);
                return Observation::new(RuntimeState::NeedsInput, Confidence::Medium, SOURCE)
                    .reason(reason)
                    .detail(detail)
                    .since(asking.at.clone().or(changed));
            }
            let reason = match tail.and_then(|t| t.pending_tool()) {
                Some(tool) => format!("Running {tool}"),
                None => "Generating".into(),
            };
            Observation::new(RuntimeState::Working, Confidence::High, SOURCE)
                .reason(reason)
                .since(changed)
                .activity(activity)
        }
        Some("waiting") => {
            let (reason, detail) = waiting_reason(l.waiting_for.as_deref(), tail);
            Observation::new(RuntimeState::NeedsInput, Confidence::High, SOURCE)
                .reason(reason)
                .detail(detail)
                .since(changed)
        }
        _ => {
            if let Some((kind, msg, at)) = tail.and_then(|t| t.api_error.clone()) {
                let (reason, action) = match kind.as_str() {
                    "authentication_failed" => ("Authentication required", true),
                    "billing_error" => ("Billing needs attention", true),
                    "rate_limit" => ("Usage limit reached", false),
                    "invalid_request" => ("Request rejected", false),
                    _ => ("Request failed", false),
                };
                return Observation::new(RuntimeState::Error, Confidence::High, SOURCE)
                    .reason(reason)
                    .detail(Some(msg))
                    .action(action)
                    .since(at.or(changed));
            }
            if tail.map(|t| t.interrupted).unwrap_or(false) {
                return Observation::new(RuntimeState::Idle, Confidence::High, SOURCE)
                    .reason("Interrupted")
                    .since(changed);
            }
            // A status change well after start means at least one turn ran and finished.
            let turn_ran =
                matches!((l.started_at, changed_ms), (Some(s), Some(c)) if c - s > 3_000);
            if turn_ran {
                Observation::new(RuntimeState::Ready, Confidence::High, SOURCE)
                    .reason("Finished its turn")
                    .since(changed)
            } else {
                Observation::new(RuntimeState::Idle, Confidence::High, SOURCE)
                    .reason("Open, no prompt yet")
                    .since(changed)
            }
        }
    }
}

/// Live sessions whose process still exists, keyed by session id.
pub fn read_registry(sessions_dir: &Path) -> HashMap<String, LiveSession> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Only `<pid>.json`; the neighbouring `.key` files are secrets and are never opened.
        let is_registry = path.extension().and_then(|e| e.to_str()) == Some("json")
            && path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false);
        if !is_registry {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(live) = serde_json::from_str::<LiveSession>(&raw) else {
            continue;
        };
        if live.spare || !pid_alive(live.pid) {
            continue;
        }
        out.insert(live.session_id.clone(), live);
    }
    out
}

/// Claude Code names project folders by replacing every non-alphanumeric char with `-`.
pub fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[derive(Debug, Default, PartialEq)]
pub struct TranscriptInfo {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub first_prompt: Option<String>,
    pub custom_title: Option<String>,
    pub agent_name: Option<String>,
    pub ai_title: Option<String>,
    pub last_timestamp: Option<String>,
    pub user_turns: usize,
    pub pr_url: Option<String>,
    pub relocated_cwd: Option<String>,
}

fn has_type(line: &str, t: &str) -> bool {
    line.contains(&format!("\"type\":\"{t}\""))
}

fn user_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            // Tool results are also "user" records; they are not prompts.
            if blocks
                .iter()
                .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
            {
                return None;
            }
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

/// Parse a transcript, touching as few lines as possible with a full JSON parse.
pub fn parse_transcript<R: BufRead>(reader: R, dir_name: &str) -> TranscriptInfo {
    let mut info = TranscriptInfo::default();
    let mut last_user_line: Option<String> = None;
    let mut last_stamped_line: Option<String> = None;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let is_user = has_type(&line, "user");
        if is_user || has_type(&line, "assistant") {
            last_stamped_line = Some(line.clone());
        }
        if is_user {
            if info.first_prompt.is_some() && info.cwd.is_some() {
                // Cheap path: count turns without parsing (tool results inflate this; it's a weight).
                if !line.contains("\"tool_result\"") && !line.contains("\"isMeta\":true") {
                    info.user_turns += 1;
                }
                last_user_line = Some(line);
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if info.session_id.is_none() {
                info.session_id = v
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .map(str::to_string);
            }
            if let Some(cwd) = v.get("cwd").and_then(|s| s.as_str()) {
                if info.cwd.is_none()
                    || (encode_project_dir(cwd) == dir_name
                        && info.cwd.as_deref().map(encode_project_dir).as_deref() != Some(dir_name))
                {
                    info.cwd = Some(cwd.to_string());
                }
            }
            let meta = v.get("isMeta").and_then(|m| m.as_bool()).unwrap_or(false);
            if !meta {
                if let Some(t) = user_text(&v) {
                    if !text::is_noise_prompt(&t) {
                        info.user_turns += 1;
                        if info.first_prompt.is_none() {
                            info.first_prompt = Some(t);
                        }
                    }
                }
            }
            last_user_line = Some(line);
            continue;
        }
        let title_field = if has_type(&line, "custom-title") {
            Some(("customTitle", 0))
        } else if has_type(&line, "agent-name") {
            Some(("agentName", 1))
        } else if has_type(&line, "ai-title") {
            Some(("aiTitle", 2))
        } else {
            None
        };
        if let Some((field, which)) = title_field {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(t) = v
                    .get(field)
                    .and_then(|s| s.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let slot = match which {
                        0 => &mut info.custom_title,
                        1 => &mut info.agent_name,
                        _ => &mut info.ai_title,
                    };
                    *slot = Some(t.to_string());
                }
            }
            continue;
        }
        if has_type(&line, "pr-link") {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                info.pr_url = v.get("prUrl").and_then(|s| s.as_str()).map(str::to_string);
            }
        } else if has_type(&line, "relocated") {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                info.relocated_cwd = v
                    .get("relocatedCwd")
                    .and_then(|s| s.as_str())
                    .map(str::to_string);
            }
        }
    }

    if let Some(v) = last_user_line.and_then(|l| serde_json::from_str::<Value>(&l).ok()) {
        info.branch = v
            .get("gitBranch")
            .and_then(|b| b.as_str())
            .filter(|b| !b.is_empty() && *b != "HEAD")
            .map(str::to_string);
    }
    if let Some(v) = last_stamped_line.and_then(|l| serde_json::from_str::<Value>(&l).ok()) {
        info.last_timestamp = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(str::to_string);
    }
    info
}

pub fn title_for(info: &TranscriptInfo, live: Option<&LiveSession>) -> String {
    let user_named = live
        .filter(|l| l.name_source.as_deref() == Some("user"))
        .and_then(|l| l.name.clone());
    info.custom_title
        .clone()
        .or(user_named)
        .or_else(|| info.agent_name.clone())
        .or_else(|| info.ai_title.clone())
        .or_else(|| {
            info.first_prompt
                .as_deref()
                .and_then(|p| text::title_from_prompt(p, 64))
        })
        .unwrap_or_else(|| "Untitled session".into())
}

fn file_mtime_iso(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let dt: chrono::DateTime<chrono::Utc> = modified.into();
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

impl SessionAdapter for ClaudeCodeAdapter {
    fn key(&self) -> &'static str {
        "claude-code-transcripts"
    }
    fn provider(&self) -> Provider {
        Provider::ClaudeCode
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn scan(&self) -> Result<ScanOutcome, HubError> {
        let projects_dir = self.root.join("projects");
        if !projects_dir.is_dir() {
            return Ok(ScanOutcome::Unavailable(
                "No Claude Code sessions were found on this Mac (~/.claude/projects is missing)."
                    .into(),
            ));
        }
        let live = read_registry(&self.root.join("sessions"));
        let dirs = std::fs::read_dir(&projects_dir).map_err(|e| {
            HubError::with_detail("Claude Code's session folder couldn't be read.", e)
        })?;

        let mut out = Vec::new();
        for dir in dirs.flatten() {
            let dir_path = dir.path();
            if !dir_path.is_dir() {
                continue;
            }
            let dir_name = dir.file_name().to_string_lossy().into_owned();
            let Ok(files) = std::fs::read_dir(&dir_path) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(file) = std::fs::File::open(&path) else {
                    continue;
                };
                let info = parse_transcript(BufReader::new(file), &dir_name);
                let Some(id) = info
                    .session_id
                    .clone()
                    .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
                else {
                    continue;
                };
                // Sessions with no real prompt (e.g. an opened-and-closed terminal) are noise.
                if info.first_prompt.is_none() && info.custom_title.is_none() {
                    continue;
                }
                let live_entry = live.get(&id);
                let cwd = info
                    .cwd
                    .clone()
                    .or_else(|| live_entry.and_then(|l| l.cwd.clone()));
                let repo = cwd
                    .as_deref()
                    .and_then(repository_root)
                    .or_else(|| cwd.as_deref().map(|c| strip_agent_worktree(c).to_string()));

                let mut meta = serde_json::Map::new();
                meta.insert("transcriptPath".into(), json!(path.to_string_lossy()));
                meta.insert("userTurns".into(), json!(info.user_turns));
                if let Some(p) = &info.first_prompt {
                    meta.insert("firstPrompt".into(), json!(text::preview(p)));
                }
                if let Some(u) = &info.pr_url {
                    meta.insert("prUrl".into(), json!(u));
                }
                if let Some(r) = &info.relocated_cwd {
                    meta.insert("worktree".into(), json!(r));
                }
                if let Some(l) = live_entry {
                    meta.insert("live".into(), json!({ "pid": l.pid, "kind": l.kind, "jobId": l.job_id, "status": l.status }));
                }

                out.push(DiscoveredSession {
                    external_id: id,
                    title: title_for(&info, live_entry),
                    working_directory: cwd,
                    repository: repo,
                    branch: info.branch.clone(),
                    deep_link: None,
                    source_url: None,
                    last_activity_at: info
                        .last_timestamp
                        .clone()
                        .or_else(|| file_mtime_iso(&path)),
                    account_hint: None,
                    metadata: meta,
                });
            }
        }
        Ok(ScanOutcome::Found(out))
    }

    fn runtime(&self, targets: &[RuntimeTarget]) -> Option<RuntimeProbe> {
        let sessions_dir = self.root.join("sessions");
        if !sessions_dir.is_dir() {
            // Older Claude Code without a registry: no honest live signal.
            return None;
        }
        let live = read_registry(&sessions_dir);
        let mut observations = HashMap::new();
        for t in targets {
            let Some(l) = live.get(t.external_id) else {
                continue;
            };
            let transcript = t
                .metadata
                .and_then(|m| m.get("transcriptPath"))
                .and_then(|p| p.as_str())
                .map(PathBuf::from)
                .or_else(|| {
                    let cwd = t.working_directory.or(l.cwd.as_deref())?;
                    Some(
                        self.root
                            .join("projects")
                            .join(encode_project_dir(cwd))
                            .join(format!("{}.jsonl", t.external_id)),
                    )
                });
            let tail = transcript.as_deref().and_then(|p| self.tail_of(p));
            let obs = observe_live(
                l,
                tail.as_ref().map(|(t, _)| t),
                tail.as_ref().map(|(_, m)| system_time_iso(*m)),
            );
            observations.insert(t.external_id.to_string(), obs);
        }
        let known: std::collections::HashSet<&str> =
            targets.iter().map(|t| t.external_id).collect();
        let unindexed_live = live
            .keys()
            .filter(|id| !known.contains(id.as_str()))
            .cloned()
            .collect();
        Some(RuntimeProbe {
            observations,
            fallback: Observation::new(RuntimeState::Offline, Confidence::High, SOURCE)
                .reason("No running process"),
            unindexed_live,
        })
    }

    fn runtime_capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities {
            live_status: "full",
            working: "full",
            needs_input: "full",
            ready: "full",
            error: "full",
            detail: "Claude Code's own session registry (busy · waiting · idle) plus the transcript tail",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"type":"mode","mode":"normal","sessionId":"s1"}
{"parentUuid":null,"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: x</local-command-caveat>"},"isMeta":true,"cwd":"/Users/j/Website","sessionId":"s1","gitBranch":"HEAD","timestamp":"2026-09-16T14:35:02.066Z"}
{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"},"cwd":"/Users/j/Website","sessionId":"s1","timestamp":"2026-09-16T14:35:03.000Z"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Build the backup / DR flow\nwith details"}]},"cwd":"/Users/j/Website","sessionId":"s1","gitBranch":"main","timestamp":"2026-09-16T14:36:00.000Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]},"sessionId":"s1","timestamp":"2026-09-16T14:36:05.000Z"}
{"type":"ai-title","aiTitle":"Backup and DR planning","sessionId":"s1"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]},"cwd":"/Users/j/Website","sessionId":"s1","gitBranch":"feat/dr","timestamp":"2026-09-16T15:00:00.000Z"}
{"type":"pr-link","prUrl":"https://github.com/o/r/pull/1","sessionId":"s1"}
"#;

    #[test]
    fn parses_transcript_fields() {
        let info = parse_transcript(SAMPLE.as_bytes(), "-Users-j-Website");
        assert_eq!(info.session_id.as_deref(), Some("s1"));
        assert_eq!(info.cwd.as_deref(), Some("/Users/j/Website"));
        assert_eq!(
            info.first_prompt.as_deref(),
            Some("Build the backup / DR flow\nwith details")
        );
        assert_eq!(info.ai_title.as_deref(), Some("Backup and DR planning"));
        assert_eq!(info.branch.as_deref(), Some("feat/dr"));
        assert_eq!(
            info.last_timestamp.as_deref(),
            Some("2026-09-16T15:00:00.000Z")
        );
        assert_eq!(
            info.pr_url.as_deref(),
            Some("https://github.com/o/r/pull/1")
        );
        assert_eq!(info.user_turns, 1);
    }

    #[test]
    fn title_precedence() {
        let mut info = parse_transcript(SAMPLE.as_bytes(), "-Users-j-Website");
        assert_eq!(title_for(&info, None), "Backup and DR planning");
        info.custom_title = Some("Backup / DR".into());
        assert_eq!(title_for(&info, None), "Backup / DR");
        info.custom_title = None;
        info.ai_title = None;
        assert_eq!(title_for(&info, None), "Build the backup / DR flow");
    }

    #[test]
    fn encodes_dirs_like_claude_code() {
        assert_eq!(
            encode_project_dir("/Users/j/backoffice/.claude/worktrees/feat+PROJ-297"),
            "-Users-j-backoffice--claude-worktrees-feat-PROJ-297"
        );
    }

    #[test]
    fn registry_ignores_dead_pids_and_key_files() {
        let dir = tempfile::tempdir().unwrap();
        let me = std::process::id();
        std::fs::write(dir.path().join(format!("{me}.json")), format!(r#"{{"pid":{me},"sessionId":"alive","kind":"bg","jobId":"abc12345","status":"busy"}}"#)).unwrap();
        std::fs::write(
            dir.path().join("999999.json"),
            r#"{"pid":999999,"sessionId":"dead"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("1.deadbeef.key"), "secret").unwrap();
        let reg = read_registry(dir.path());
        assert_eq!(reg.len(), 1);
        assert_eq!(
            observe_live(&reg["alive"], None, None).state,
            RuntimeState::Working
        );
        assert!(reg["alive"].is_background());
    }

    fn live(status: &str, waiting_for: Option<&str>, started: i64, changed: i64) -> LiveSession {
        serde_json::from_value(json!({
            "pid": 1, "sessionId": "s", "status": status, "waitingFor": waiting_for,
            "startedAt": started, "statusUpdatedAt": changed
        }))
        .unwrap()
    }

    const TOOL_PENDING: &str = r#"{"type":"user","message":{"role":"user","content":"fix the build"},"timestamp":"2026-09-24T10:00:00.000Z"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Running tests"},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]},"timestamp":"2026-09-24T10:00:02.000Z"}
"#;

    #[test]
    fn maps_registry_states() {
        let tail = parse_transcript_tail(TOOL_PENDING);
        assert_eq!(tail.pending_tool(), Some("Bash"));

        let busy = observe_live(&live("busy", None, 0, 10_000), Some(&tail), None);
        assert_eq!(
            (busy.state, busy.confidence, busy.reason.as_deref()),
            (
                RuntimeState::Working,
                Confidence::High,
                Some("Running Bash")
            )
        );

        let perm = observe_live(
            &live("waiting", Some("permission prompt"), 0, 10_000),
            Some(&tail),
            None,
        );
        assert_eq!(perm.state, RuntimeState::NeedsInput);
        assert!(perm.action_required);
        assert_eq!(perm.reason.as_deref(), Some("Waiting for permission"));
        assert_eq!(perm.detail.as_deref(), Some("Bash"));
        assert_eq!(perm.since.as_deref(), Some("1970-01-01T00:00:10.000Z"));

        // Idle right after start: no turn ran → idle. Idle after a turn → ready, not needs-input.
        assert_eq!(
            observe_live(&live("idle", None, 0, 500), None, None).state,
            RuntimeState::Idle
        );
        let ready = observe_live(&live("idle", None, 0, 60_000), None, None);
        assert_eq!(ready.state, RuntimeState::Ready);
        assert!(!ready.action_required);
        assert_eq!(
            observe_live(&live("shell", None, 0, 60_000), None, None).state,
            RuntimeState::Ready
        );
    }

    #[test]
    fn detects_questions_errors_and_interrupts() {
        let ask = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Which database?"}]}}]}}"#;
        let o = observe_live(
            &live("waiting", Some("permission prompt"), 0, 9_000),
            Some(&parse_transcript_tail(ask)),
            None,
        );
        assert_eq!(
            (o.reason.as_deref(), o.detail.as_deref()),
            (Some("Asked a question"), Some("Which database?"))
        );

        let err = r#"{"type":"assistant","isApiErrorMessage":true,"error":"authentication_failed","message":{"content":[{"type":"text","text":"Please run /login"}]},"timestamp":"2026-09-24T10:00:00.000Z"}"#;
        let o = observe_live(
            &live("idle", None, 0, 9_000),
            Some(&parse_transcript_tail(err)),
            None,
        );
        assert_eq!((o.state, o.action_required), (RuntimeState::Error, true));
        assert_eq!(o.reason.as_deref(), Some("Authentication required"));
        let limit = err.replace("authentication_failed", "rate_limit");
        let o = observe_live(
            &live("idle", None, 0, 9_000),
            Some(&parse_transcript_tail(&limit)),
            None,
        );
        assert_eq!((o.state, o.action_required), (RuntimeState::Error, false));

        // A new prompt after an error clears it; a tool result clears the pending tool.
        let recovered = format!(
            "{err}\n{}",
            r#"{"type":"user","message":{"content":"try again"}}"#
        );
        assert_eq!(parse_transcript_tail(&recovered).api_error, None);
        let done = format!(
            "{TOOL_PENDING}{}",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#
        );
        assert_eq!(parse_transcript_tail(&done).pending_tool(), None);

        let stop = r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        assert_eq!(
            observe_live(
                &live("idle", None, 0, 9_000),
                Some(&parse_transcript_tail(stop)),
                None
            )
            .reason
            .as_deref(),
            Some("Interrupted")
        );
    }

    /// Parallel calls: one line per content block, results arriving one by one.
    const PARALLEL: &str = r#"{"type":"user","message":{"role":"user","content":"deploy it"},"timestamp":"2026-09-24T10:00:00.000Z"}
{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"…"}]},"timestamp":"2026-09-24T10:00:01.000Z"}
{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]},"timestamp":"2026-09-24T10:00:02.000Z"}
{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"./deploy.sh"}}]},"timestamp":"2026-09-24T10:00:02.100Z"}
{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t3","name":"Grep","input":{}}]},"timestamp":"2026-09-24T10:00:02.200Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]},"timestamp":"2026-09-24T10:00:03.000Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t3","content":"y"}]},"timestamp":"2026-09-24T10:00:03.100Z"}
"#;

    #[test]
    fn a_finished_parallel_tool_does_not_settle_the_one_waiting() {
        let tail = parse_transcript_tail(PARALLEL);
        assert_eq!(tail.pending_tool(), Some("Bash"));
        let o = observe_live(
            &live("waiting", Some("permission prompt"), 0, 10_000),
            Some(&tail),
            None,
        );
        assert_eq!(
            (o.state, o.reason.as_deref(), o.detail.as_deref()),
            (
                RuntimeState::NeedsInput,
                Some("Waiting for permission"),
                Some("Bash")
            )
        );
        let done = format!(
            "{PARALLEL}{}",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}"#
        );
        assert_eq!(parse_transcript_tail(&done).pending, vec![]);
    }

    #[test]
    fn questions_and_plans_need_you_even_if_the_registry_says_busy() {
        let ask = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[{"question":"Which database?"}]}}]},"timestamp":"2026-09-24T10:00:05.000Z"}"#;
        let o = observe_live(
            &live("busy", None, 0, 9_000),
            Some(&parse_transcript_tail(ask)),
            None,
        );
        assert_eq!(
            (
                o.state,
                o.confidence,
                o.reason.as_deref(),
                o.detail.as_deref()
            ),
            (
                RuntimeState::NeedsInput,
                Confidence::Medium,
                Some("Asked a question"),
                Some("Which database?")
            )
        );
        assert!(o.action_required);
        assert_eq!(o.since.as_deref(), Some("2026-09-24T10:00:05.000Z"));

        let plan = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"p1","name":"ExitPlanMode","input":{"plan":"1. …"}}]}}"#;
        let o = observe_live(
            &live("busy", None, 0, 9_000),
            Some(&parse_transcript_tail(plan)),
            None,
        );
        assert_eq!(
            (o.state, o.reason.as_deref()),
            (RuntimeState::NeedsInput, Some("Plan needs approval"))
        );

        // Answered: back to work.
        let answered = format!(
            "{ask}\n{}",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Postgres"}]}}"#
        );
        assert_eq!(
            observe_live(
                &live("busy", None, 0, 9_000),
                Some(&parse_transcript_tail(&answered)),
                None
            )
            .state,
            RuntimeState::Working
        );
        // Any other pending tool on a busy session is work, not a wait: most run unasked.
        let o = observe_live(
            &live("busy", None, 0, 9_000),
            Some(&parse_transcript_tail(PARALLEL)),
            None,
        );
        assert_eq!(
            (o.state, o.reason.as_deref()),
            (RuntimeState::Working, Some("Running Bash"))
        );
    }

    #[test]
    fn runtime_probe_marks_missing_processes_offline() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sessions")).unwrap();
        let me = std::process::id();
        std::fs::write(
            dir.path().join(format!("sessions/{me}.json")),
            format!(r#"{{"pid":{me},"sessionId":"live-1","status":"waiting","waitingFor":"dialog open","startedAt":1,"statusUpdatedAt":99999}}"#),
        )
        .unwrap();
        let a = ClaudeCodeAdapter::new(dir.path().to_path_buf());
        let targets = [RuntimeTarget {
            external_id: "old",
            working_directory: None,
            metadata: None,
        }];
        let probe = a.runtime(&targets).unwrap();
        assert!(probe.observations.is_empty());
        assert_eq!(probe.fallback.state, RuntimeState::Offline);
        assert_eq!(probe.unindexed_live, vec!["live-1".to_string()]);
        let targets = [RuntimeTarget {
            external_id: "live-1",
            working_directory: None,
            metadata: None,
        }];
        let probe = a.runtime(&targets).unwrap();
        assert_eq!(
            probe.observations["live-1"].reason.as_deref(),
            Some("Needs confirmation")
        );
    }
}
