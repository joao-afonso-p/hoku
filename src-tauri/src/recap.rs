//! Recaps: a bounded, source-backed summary of one period, plus the outcomes the user wrote
//! for it. Everything here is an observation Hoku can stand behind:
//!
//! - A session counts as active in the period when its provider reported activity then
//!   (`last_activity_at`) or the runtime monitor recorded a transition for it then. The
//!   period always ends at `until`, so "last activity after `since`" is exact for ranges that
//!   end now, and a lower bound otherwise.
//! - Runtime transitions (`activity_events`) exist only while Hoku was running, and are kept
//!   for [`crate::runtime::EVENT_RETENTION_DAYS`]. [`RecapCoverage`] says how much of the
//!   period that history covers, so the UI never implies more than it saw.
//! - "Ready" means a turn finished. It is never treated as a task being done: outcomes only
//!   come from what the user writes ([`Outcome`]).
//!
//! No cost, time-saved, token or productivity figures are computed here, on purpose.

use crate::db::{new_id, now_iso};
use crate::models::{HubError, HubResult, Provider};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The longest period a recap can cover: the runtime history's retention.
pub const MAX_RANGE_DAYS: i64 = crate::runtime::EVENT_RETENTION_DAYS;
/// Outcomes are one-line milestones, not notes.
pub const OUTCOME_MAX_CHARS: usize = 140;
/// Pull requests listed per recap. More than this isn't a recap any more.
const MAX_PULL_REQUESTS: usize = 40;
pub const UNSORTED: &str = "unsorted";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapQuery {
    /// Start of the period (RFC 3339).
    pub since: String,
    /// End of the period (RFC 3339), usually now.
    pub until: String,
    /// The viewer's UTC offset, so days are the user's local days.
    #[serde(default)]
    pub utc_offset_minutes: i32,
    /// Project ids (or "unsorted") to include. Empty or absent = every project.
    #[serde(default)]
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecapDay {
    /// Local calendar day, `YYYY-MM-DD`.
    pub date: String,
    /// Distinct sessions active that day.
    pub sessions: usize,
    /// Hoku recorded at least one runtime transition that day (any project). Days without
    /// one may simply be days Hoku wasn't running.
    pub observed: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecapTotals {
    /// Named projects with at least one active session (Unsorted isn't a project).
    pub projects: usize,
    pub sessions: usize,
    pub active_days: usize,
    /// Sessions the runtime monitor saw change state in the period.
    pub observed_sessions: usize,
    /// `started_working` transitions: a turn began.
    pub work_starts: usize,
    /// `became_ready` transitions: a turn finished and handed back. Not a completed task.
    pub ready_transitions: usize,
    /// `needs_input` transitions: a session asked for permission, an answer or a choice.
    pub input_requests: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecapProvider {
    pub provider: Provider,
    pub sessions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapProject {
    /// Project id, or "unsorted".
    pub key: String,
    pub name: String,
    pub color: Option<String>,
    pub is_demo: bool,
    pub archived: bool,
    pub sessions: usize,
    pub active_days: usize,
    pub ready_transitions: usize,
    pub pull_requests: usize,
    pub providers: Vec<RecapProvider>,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecapPullRequest {
    pub session_id: String,
    pub project_key: String,
    /// As recorded by the provider. Shown in the app; never placed on a share card.
    pub url: String,
    /// `owner/repo` when the URL has that shape.
    pub repo: Option<String>,
    pub number: Option<u64>,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecapCoverage {
    pub retention_days: i64,
    /// The oldest runtime transition Hoku still has, for any session.
    pub history_since: Option<String>,
    /// The runtime history reaches back to the start of the period.
    pub history_covers_range: bool,
    /// Days in the period with at least one recorded transition.
    pub observed_days: usize,
    pub range_days: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub id: String,
    pub project_id: Option<String>,
    pub text: String,
    /// Local calendar day, `YYYY-MM-DD`.
    pub occurred_on: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeInput {
    pub project_id: Option<String>,
    pub text: String,
    pub occurred_on: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recap {
    pub since: String,
    pub until: String,
    pub days: Vec<RecapDay>,
    pub totals: RecapTotals,
    pub providers: Vec<RecapProvider>,
    pub projects: Vec<RecapProject>,
    pub pull_requests: Vec<RecapPullRequest>,
    pub outcomes: Vec<Outcome>,
    pub coverage: RecapCoverage,
}

fn parse_instant(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Same format the runtime monitor writes, so text comparison against events is exact.
fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Period {
    since: DateTime<Utc>,
    until: DateTime<Utc>,
    offset: FixedOffset,
}

impl Period {
    fn from_query(q: &RecapQuery) -> HubResult<Self> {
        let since = parse_instant(&q.since)
            .ok_or_else(|| HubError::with_detail("That recap period isn't valid.", &q.since))?;
        let until = parse_instant(&q.until)
            .ok_or_else(|| HubError::with_detail("That recap period isn't valid.", &q.until))?;
        if until <= since {
            return Err(HubError::new("A recap period has to end after it starts."));
        }
        // A day of slack for a local-midnight start.
        if until - since > Duration::days(MAX_RANGE_DAYS + 1) {
            return Err(HubError::new(format!(
                "Recaps cover at most {MAX_RANGE_DAYS} days, the length of Hoku's runtime history."
            )));
        }
        let offset = FixedOffset::east_opt(q.utc_offset_minutes.clamp(-14 * 60, 14 * 60) * 60)
            .expect("clamped offset");
        Ok(Period {
            since,
            until,
            offset,
        })
    }

    fn day(&self, t: DateTime<Utc>) -> NaiveDate {
        t.with_timezone(&self.offset).date_naive()
    }

    fn days(&self) -> Vec<NaiveDate> {
        let (first, last) = (self.day(self.since), self.day(self.until));
        first.iter_days().take_while(|d| *d <= last).collect()
    }

    /// SQLite `date()` modifier for the offset, e.g. "+120 minutes".
    fn sqlite_modifier(&self) -> String {
        format!("{:+} minutes", self.offset.local_minus_utc() / 60)
    }

    fn contains(&self, t: DateTime<Utc>) -> bool {
        t >= self.since && t <= self.until
    }
}

#[derive(Default)]
struct SessionAgg {
    provider: Option<Provider>,
    project_key: String,
    days: BTreeSet<NaiveDate>,
    observed: bool,
    work_starts: usize,
    ready: usize,
    input: usize,
    last_activity: Option<DateTime<Utc>>,
    pr_url: Option<String>,
}

struct ProjectRow {
    name: String,
    color: Option<String>,
    is_demo: bool,
    archived: bool,
}

/// `https://github.com/owner/repo/pull/12` → ("owner/repo", 12). Other hosts with the same
/// shape (GitHub Enterprise) work too; GitLab merge requests keep just the number.
pub fn parse_pr_url(url: &str) -> Option<(Option<String>, Option<u64>)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let parts: Vec<&str> = rest.split(['?', '#']).next()?.split('/').collect();
    if parts.len() < 2 || parts[0].is_empty() {
        return None;
    }
    let number_after = |marker: &str| {
        parts
            .iter()
            .position(|p| *p == marker)
            .and_then(|i| parts.get(i + 1))
            .and_then(|n| n.parse::<u64>().ok())
    };
    if let (Some(n), true) = (number_after("pull"), parts.len() >= 5) {
        return Some((Some(format!("{}/{}", parts[1], parts[2])), Some(n)));
    }
    Some((None, number_after("merge_requests")))
}

pub fn build(conn: &Connection, q: &RecapQuery) -> HubResult<Recap> {
    let period = Period::from_query(q)?;
    let filter: BTreeSet<&str> = q.projects.iter().map(String::as_str).collect();

    let mut projects: HashMap<String, ProjectRow> = HashMap::new();
    {
        let mut st = conn.prepare("SELECT id, name, color, is_demo, archived_at FROM projects")?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                ProjectRow {
                    name: r.get(1)?,
                    color: r.get(2)?,
                    is_demo: r.get::<_, i64>(3)? != 0,
                    archived: r.get::<_, Option<String>>(4)?.is_some(),
                },
            ))
        })?;
        for row in rows {
            let (id, p) = row?;
            projects.insert(id, p);
        }
    }
    let project_key = |id: Option<String>| match id {
        Some(id) if projects.contains_key(&id) => id,
        _ => UNSORTED.to_string(),
    };

    let mut sessions: HashMap<String, SessionAgg> = HashMap::new();

    // 1. Provider-reported last activity. Timestamps come from provider stores in slightly
    //    different RFC 3339 shapes, so SQL narrows by date prefix and Rust decides exactly.
    {
        let floor = (period.since - Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let mut st = conn.prepare(
            "SELECT id, provider, project_id, last_activity_at, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.prUrl') END
               FROM sessions WHERE last_activity_at >= ?1",
        )?;
        let rows = st.query_map([floor], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4).unwrap_or(None),
            ))
        })?;
        for row in rows {
            let (id, provider, project_id, last, pr) = row?;
            let Some(t) = parse_instant(&last).filter(|t| period.contains(*t)) else {
                continue;
            };
            let a = sessions.entry(id).or_default();
            a.provider = Provider::parse(&provider);
            a.project_key = project_key(project_id);
            a.days.insert(period.day(t));
            a.last_activity = Some(t);
            a.pr_url = pr;
        }
    }

    // 2. Runtime transitions in the period, grouped per session, local day and type. Bounded
    //    by the period and the retention window, never by an arbitrary row cap. "created" is
    //    Hoku indexing a manual session, not the session doing anything.
    let modifier = period.sqlite_modifier();
    {
        let mut st = conn.prepare(
            "SELECT e.session_id, s.provider, s.project_id, date(e.timestamp, ?3) AS day, e.type,
                    COUNT(*), MAX(e.timestamp), CASE WHEN json_valid(s.metadata) THEN json_extract(s.metadata, '$.prUrl') END
               FROM activity_events e JOIN sessions s ON s.id = e.session_id
              WHERE e.timestamp >= ?1 AND e.timestamp <= ?2 AND e.type != 'created'
              GROUP BY e.session_id, day, e.type",
        )?;
        let rows = st.query_map(
            params![iso(period.since), iso(period.until), modifier],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)? as usize,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7).unwrap_or(None),
                ))
            },
        )?;
        for row in rows {
            let (id, provider, project_id, day, kind, n, latest, pr) = row?;
            let Ok(day) = NaiveDate::parse_from_str(&day, "%Y-%m-%d") else {
                continue;
            };
            let a = sessions.entry(id).or_default();
            a.provider = a.provider.or(Provider::parse(&provider));
            a.project_key = project_key(project_id);
            a.days.insert(day);
            a.observed = true;
            if a.pr_url.is_none() {
                a.pr_url = pr;
            }
            if let Some(t) = parse_instant(&latest) {
                a.last_activity = a.last_activity.max(Some(t));
            }
            match kind.as_str() {
                "started_working" => a.work_starts += n,
                "became_ready" => a.ready += n,
                "needs_input" => a.input += n,
                _ => {}
            }
        }
    }

    // Days Hoku was observing at all (any project): the honest denominator for coverage.
    let observed_days: BTreeSet<NaiveDate> = {
        let mut st = conn.prepare(
            "SELECT DISTINCT date(timestamp, ?3) FROM activity_events
              WHERE timestamp >= ?1 AND timestamp <= ?2",
        )?;
        let rows = st.query_map(
            params![iso(period.since), iso(period.until), modifier],
            |r| r.get::<_, String>(0),
        )?;
        rows.filter_map(|d| d.ok())
            .filter_map(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok())
            .collect()
    };
    let history_since: Option<String> = conn
        .query_row("SELECT MIN(timestamp) FROM activity_events", [], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();

    sessions.retain(|_, a| {
        a.provider.is_some()
            && !a.days.is_empty()
            && (filter.is_empty() || filter.contains(a.project_key.as_str()))
    });

    // Aggregate.
    let mut totals = RecapTotals {
        sessions: sessions.len(),
        ..Default::default()
    };
    let mut per_day: BTreeMap<NaiveDate, usize> = BTreeMap::new();
    let mut per_provider: BTreeMap<&'static str, (Provider, usize)> = BTreeMap::new();
    struct ProjectAgg {
        sessions: usize,
        days: BTreeSet<NaiveDate>,
        ready: usize,
        prs: usize,
        providers: BTreeMap<&'static str, (Provider, usize)>,
        last: Option<DateTime<Utc>>,
    }
    let mut per_project: BTreeMap<String, ProjectAgg> = BTreeMap::new();
    let mut pull_requests: Vec<RecapPullRequest> = Vec::new();
    let mut seen_prs: BTreeSet<String> = BTreeSet::new();

    for (id, a) in &sessions {
        let provider = a.provider.expect("retained");
        for d in &a.days {
            *per_day.entry(*d).or_default() += 1;
        }
        per_provider
            .entry(provider.as_str())
            .or_insert((provider, 0))
            .1 += 1;
        totals.observed_sessions += a.observed as usize;
        totals.work_starts += a.work_starts;
        totals.ready_transitions += a.ready;
        totals.input_requests += a.input;

        let p = per_project
            .entry(a.project_key.clone())
            .or_insert_with(|| ProjectAgg {
                sessions: 0,
                days: BTreeSet::new(),
                ready: 0,
                prs: 0,
                providers: BTreeMap::new(),
                last: None,
            });
        p.sessions += 1;
        p.days.extend(a.days.iter().copied());
        p.ready += a.ready;
        p.providers
            .entry(provider.as_str())
            .or_insert((provider, 0))
            .1 += 1;
        p.last = p.last.max(a.last_activity);

        if let Some(url) = a.pr_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            if let Some((repo, number)) = parse_pr_url(url) {
                if seen_prs.insert(url.to_string()) {
                    p.prs += 1;
                    pull_requests.push(RecapPullRequest {
                        session_id: id.clone(),
                        project_key: a.project_key.clone(),
                        url: url.to_string(),
                        repo,
                        number,
                        last_activity_at: a.last_activity.map(iso),
                    });
                }
            }
        }
    }
    totals.active_days = per_day.len();
    totals.projects = per_project.keys().filter(|k| *k != UNSORTED).count();

    let providers_vec = |m: BTreeMap<&'static str, (Provider, usize)>| {
        let mut v: Vec<RecapProvider> = m
            .into_values()
            .map(|(provider, sessions)| RecapProvider { provider, sessions })
            .collect();
        v.sort_by(|a, b| b.sessions.cmp(&a.sessions));
        v
    };

    let mut recap_projects: Vec<RecapProject> = per_project
        .into_iter()
        .map(|(key, a)| {
            let row = projects.get(&key);
            RecapProject {
                name: row
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| "Unsorted".into()),
                color: row.and_then(|p| p.color.clone()),
                is_demo: row.map(|p| p.is_demo).unwrap_or(false),
                archived: row.map(|p| p.archived).unwrap_or(false),
                sessions: a.sessions,
                active_days: a.days.len(),
                ready_transitions: a.ready,
                pull_requests: a.prs,
                providers: providers_vec(a.providers),
                last_activity_at: a.last.map(iso),
                key,
            }
        })
        .collect();
    // Most active first; Unsorted always last.
    recap_projects.sort_by(|a, b| {
        (a.key == UNSORTED)
            .cmp(&(b.key == UNSORTED))
            .then(b.active_days.cmp(&a.active_days))
            .then(b.sessions.cmp(&a.sessions))
            .then(a.name.cmp(&b.name))
    });

    pull_requests.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    pull_requests.truncate(MAX_PULL_REQUESTS);

    let days: Vec<RecapDay> = period
        .days()
        .into_iter()
        .map(|d| RecapDay {
            date: d.format("%Y-%m-%d").to_string(),
            sessions: per_day.get(&d).copied().unwrap_or(0),
            observed: observed_days.contains(&d),
        })
        .collect();

    let outcomes = list_outcomes(
        conn,
        &period.day(period.since).format("%Y-%m-%d").to_string(),
        &period.day(period.until).format("%Y-%m-%d").to_string(),
    )?
    .into_iter()
    .filter(|o| filter.is_empty() || filter.contains(project_key(o.project_id.clone()).as_str()))
    .collect();

    let coverage = RecapCoverage {
        retention_days: MAX_RANGE_DAYS,
        history_covers_range: history_since
            .as_deref()
            .and_then(parse_instant)
            .map(|t| t <= period.since)
            .unwrap_or(false),
        history_since,
        observed_days: observed_days.len(),
        range_days: days.len(),
    };

    Ok(Recap {
        since: iso(period.since),
        until: iso(period.until),
        days,
        totals,
        providers: providers_vec(per_provider),
        projects: recap_projects,
        pull_requests,
        outcomes,
        coverage,
    })
}

// ───────────────────────────── outcomes ─────────────────────────────

fn row_outcome(r: &Row) -> rusqlite::Result<Outcome> {
    Ok(Outcome {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        text: r.get("text")?,
        occurred_on: r.get("occurred_on")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// Outcomes dated within `[from, to]` (inclusive, `YYYY-MM-DD`), newest first.
pub fn list_outcomes(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<Vec<Outcome>> {
    let mut st = conn.prepare(
        "SELECT * FROM recap_outcomes WHERE occurred_on >= ?1 AND occurred_on <= ?2
          ORDER BY occurred_on DESC, created_at DESC",
    )?;
    let rows = st.query_map(params![from, to], row_outcome)?;
    rows.collect()
}

fn get_outcome(conn: &Connection, id: &str) -> rusqlite::Result<Option<Outcome>> {
    conn.query_row(
        "SELECT * FROM recap_outcomes WHERE id = ?",
        [id],
        row_outcome,
    )
    .optional()
}

/// One line, trimmed, whitespace collapsed, at most [`OUTCOME_MAX_CHARS`] characters.
fn clean_outcome(
    conn: &Connection,
    input: &OutcomeInput,
) -> HubResult<(String, String, Option<String>)> {
    let text = input.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(HubError::new("Write the outcome in a few words."));
    }
    if text.chars().count() > OUTCOME_MAX_CHARS {
        return Err(HubError::new(format!(
            "Keep an outcome under {OUTCOME_MAX_CHARS} characters."
        )));
    }
    let day = NaiveDate::parse_from_str(input.occurred_on.trim(), "%Y-%m-%d")
        .map_err(|_| HubError::with_detail("That date isn't valid.", &input.occurred_on))?;
    let project = match input.project_id.as_deref().filter(|p| *p != UNSORTED) {
        None => None,
        Some(p) => {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)",
                [p],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(HubError::new("That project no longer exists."));
            }
            Some(p.to_string())
        }
    };
    Ok((text, day.format("%Y-%m-%d").to_string(), project))
}

pub fn create_outcome(conn: &Connection, input: &OutcomeInput) -> HubResult<Outcome> {
    let (text, day, project) = clean_outcome(conn, input)?;
    let id = new_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO recap_outcomes (id, project_id, text, occurred_on, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, project, text, day, now],
    )?;
    Ok(get_outcome(conn, &id)?.expect("inserted"))
}

pub fn update_outcome(conn: &Connection, id: &str, input: &OutcomeInput) -> HubResult<Outcome> {
    let (text, day, project) = clean_outcome(conn, input)?;
    let n = conn.execute(
        "UPDATE recap_outcomes SET project_id = ?2, text = ?3, occurred_on = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, project, text, day, now_iso()],
    )?;
    if n == 0 {
        return Err(HubError::new("That outcome no longer exists."));
    }
    Ok(get_outcome(conn, id)?.expect("exists"))
}

pub fn delete_outcome(conn: &Connection, id: &str) -> HubResult<()> {
    conn.execute("DELETE FROM recap_outcomes WHERE id = ?", [id])?;
    Ok(())
}

// ───────────────────────────── export ─────────────────────────────

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
/// A 2× share card is a few MB at most; anything far beyond that isn't one.
const MAX_EXPORT_BYTES: usize = 25 * 1024 * 1024;

pub fn check_png(bytes: &[u8]) -> HubResult<()> {
    if bytes.len() > MAX_EXPORT_BYTES || !bytes.starts_with(PNG_SIGNATURE) {
        return Err(HubError::new("That image couldn't be exported."));
    }
    Ok(())
}

/// A free file name in `dir`: "Hoku recap 2026-09-27.png", then "… 2.png", "… 3.png".
pub fn export_path(dir: &std::path::Path, day: &str) -> std::path::PathBuf {
    let base = format!("Hoku recap {day}");
    let mut path = dir.join(format!("{base}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} {n}.png"));
        n += 1;
    }
    path
}

/// Write a user-exported card to `dir` (the Downloads folder). Never overwrites a file.
pub fn save_png(dir: &std::path::Path, bytes: &[u8]) -> HubResult<std::path::PathBuf> {
    check_png(bytes)?;
    if !dir.is_dir() {
        return Err(HubError::with_detail(
            "The Downloads folder isn't available.",
            dir.display(),
        ));
    }
    // The user's calendar day, as they would name the file.
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let path = export_path(dir, &day);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| HubError::with_detail("The image couldn't be saved.", e))?;
    std::io::Write::write_all(&mut f, bytes)
        .map_err(|e| HubError::with_detail("The image couldn't be saved.", e))?;
    Ok(path)
}

/// Put a PNG on the general pasteboard, so it pastes into LinkedIn, Slack or Teams.
#[cfg(target_os = "macos")]
pub fn copy_png(bytes: &[u8]) -> HubResult<()> {
    check_png(bytes)?;
    write_png(&objc2_app_kit::NSPasteboard::generalPasteboard(), bytes)
}

#[cfg(target_os = "macos")]
fn write_png(pb: &objc2_app_kit::NSPasteboard, bytes: &[u8]) -> HubResult<()> {
    use objc2_foundation::NSData;
    pb.clearContents();
    let data = NSData::with_bytes(bytes);
    if pb.setData_forType(Some(&data), unsafe { objc2_app_kit::NSPasteboardTypePNG }) {
        Ok(())
    } else {
        Err(HubError::new("The image couldn't be copied."))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn copy_png(_: &[u8]) -> HubResult<()> {
    Err(HubError::new("Copying images is macOS-only."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, insert_event, open_in_memory, upsert_discovered, ProjectInput};
    use crate::models::{ActivityEvent, DiscoveredSession, RuntimeState};
    use serde_json::json;

    const NOW: &str = "2026-09-24T12:00:00.000Z";

    fn at(days_ago: i64, hours: i64) -> String {
        iso(parse_instant(NOW).unwrap() - Duration::days(days_ago) - Duration::hours(hours))
    }

    fn query(days: i64, projects: Vec<String>) -> RecapQuery {
        RecapQuery {
            since: at(days, 0),
            until: NOW.into(),
            utc_offset_minutes: 0,
            projects,
        }
    }

    fn project(c: &Connection, name: &str) -> String {
        db::create_project(
            c,
            ProjectInput {
                name: name.into(),
                root_path: None,
                icon: None,
                color: Some("#8ea8e0".into()),
                is_demo: false,
            },
        )
        .unwrap()
        .id
    }

    fn session(
        c: &Connection,
        provider: Provider,
        ext: &str,
        project: Option<&str>,
        last: Option<String>,
        meta: serde_json::Value,
    ) -> String {
        let d = DiscoveredSession {
            external_id: ext.into(),
            title: format!("Session {ext}"),
            last_activity_at: last,
            metadata: meta.as_object().cloned().unwrap_or_default(),
            ..Default::default()
        };
        upsert_discovered(c, provider, "test", &d, project.map(Into::into), None).unwrap();
        db::find_session_by_external(c, provider, ext)
            .unwrap()
            .unwrap()
            .id
    }

    fn event(c: &Connection, session: &str, kind: &str, ts: String) {
        insert_event(
            c,
            &ActivityEvent {
                id: new_id(),
                session_id: session.into(),
                event_type: kind.into(),
                provider: Provider::Codex,
                timestamp: ts,
                title: Some("private title".into()),
                from_state: None,
                to_state: Some(RuntimeState::Ready),
                reason: None,
                metadata: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn counts_sessions_from_provider_activity_and_runtime_history() {
        let c = open_in_memory();
        let atlas = project(&c, "Atlas");
        // Provider-reported activity inside the period, no runtime history at all.
        session(
            &c,
            Provider::ClaudeCode,
            "a",
            Some(&atlas),
            Some(at(2, 0)),
            json!({}),
        );
        // Last provider activity is older, but Hoku saw it work inside the period.
        let b = session(
            &c,
            Provider::Codex,
            "b",
            Some(&atlas),
            Some(at(40, 0)),
            json!({}),
        );
        event(&c, &b, "started_working", at(3, 2));
        event(&c, &b, "became_ready", at(3, 1));
        event(&c, &b, "became_ready", at(1, 1));
        // Outside the period entirely.
        session(&c, Provider::Codex, "old", None, Some(at(20, 0)), json!({}));

        let r = build(&c, &query(7, vec![])).unwrap();
        assert_eq!(r.totals.sessions, 2);
        assert_eq!(r.totals.projects, 1);
        assert_eq!(r.totals.observed_sessions, 1);
        assert_eq!(r.totals.work_starts, 1);
        assert_eq!(r.totals.ready_transitions, 2);
        assert_eq!(r.totals.active_days, 3);
        assert_eq!(r.days.len(), 8);
        assert_eq!(r.days.iter().filter(|d| d.observed).count(), 2);
        assert_eq!(r.projects.len(), 1);
        assert_eq!(r.projects[0].name, "Atlas");
        assert_eq!(r.projects[0].active_days, 3);
        let mix: Vec<_> = r
            .providers
            .iter()
            .map(|p| (p.provider, p.sessions))
            .collect();
        assert!(mix.contains(&(Provider::ClaudeCode, 1)) && mix.contains(&(Provider::Codex, 1)));
    }

    #[test]
    fn is_not_capped_like_the_snapshot() {
        let c = open_in_memory();
        let s = session(&c, Provider::Codex, "busy", None, None, json!({}));
        // More events than the snapshot's 600, spread over 60 days.
        for i in 0..900 {
            event(&c, &s, "became_ready", at(i % 60, 0));
        }
        let r = build(&c, &query(89, vec![])).unwrap();
        assert_eq!(r.totals.ready_transitions, 900);
        assert_eq!(r.totals.active_days, 60);
        assert_eq!(r.coverage.observed_days, 60);
        assert!(
            !r.coverage.history_covers_range,
            "history starts 59 days ago"
        );
        // Still one session: counts are per session, not per event.
        assert_eq!(r.totals.sessions, 1);
    }

    #[test]
    fn coverage_is_reported_honestly() {
        let c = open_in_memory();
        let r = build(&c, &query(30, vec![])).unwrap();
        assert_eq!(r.coverage.history_since, None);
        assert!(!r.coverage.history_covers_range);
        assert_eq!(r.coverage.observed_days, 0);
        assert_eq!(r.coverage.retention_days, 90);

        let s = session(&c, Provider::Codex, "x", None, None, json!({}));
        event(&c, &s, "opened", at(45, 0));
        let r = build(&c, &query(30, vec![])).unwrap();
        assert!(r.coverage.history_covers_range);
        assert_eq!(r.coverage.observed_days, 0, "nothing inside the period");
    }

    #[test]
    fn manual_adds_are_not_activity() {
        let c = open_in_memory();
        let s = session(&c, Provider::Claude, "m", None, None, json!({}));
        event(&c, &s, "created", at(1, 0));
        let r = build(&c, &query(7, vec![])).unwrap();
        assert_eq!(r.totals.sessions, 0);
    }

    #[test]
    fn filters_by_project_and_keeps_unsorted_separate() {
        let c = open_in_memory();
        let atlas = project(&c, "Atlas");
        let lyra = project(&c, "Lyra");
        session(
            &c,
            Provider::Codex,
            "1",
            Some(&atlas),
            Some(at(1, 0)),
            json!({}),
        );
        session(
            &c,
            Provider::Codex,
            "2",
            Some(&lyra),
            Some(at(1, 0)),
            json!({}),
        );
        session(&c, Provider::Codex, "3", None, Some(at(1, 0)), json!({}));

        let all = build(&c, &query(7, vec![])).unwrap();
        assert_eq!((all.totals.sessions, all.totals.projects), (3, 2));
        assert_eq!(all.projects.last().unwrap().key, UNSORTED);

        let one = build(&c, &query(7, vec![atlas.clone()])).unwrap();
        assert_eq!((one.totals.sessions, one.totals.projects), (1, 1));
        assert_eq!(one.projects[0].key, atlas);

        let unsorted = build(&c, &query(7, vec![UNSORTED.into()])).unwrap();
        assert_eq!((unsorted.totals.sessions, unsorted.totals.projects), (1, 0));
    }

    #[test]
    fn buckets_days_in_the_viewers_time_zone() {
        let c = open_in_memory();
        let s = session(&c, Provider::Codex, "tz", None, None, json!({}));
        // 23:30 UTC on Sep 22 is Sep 23 in UTC+2.
        event(&c, &s, "became_ready", "2026-09-22T23:30:00.000Z".into());
        let mut q = query(7, vec![]);
        let utc = build(&c, &q).unwrap();
        assert!(utc
            .days
            .iter()
            .any(|d| d.date == "2026-09-22" && d.sessions == 1));
        q.utc_offset_minutes = 120;
        let local = build(&c, &q).unwrap();
        assert!(local
            .days
            .iter()
            .any(|d| d.date == "2026-09-23" && d.sessions == 1));
        assert!(local
            .days
            .iter()
            .all(|d| d.date != "2026-09-22" || d.sessions == 0));
    }

    #[test]
    fn lists_linked_pull_requests_once() {
        let c = open_in_memory();
        let p = project(&c, "Atlas");
        let url = "https://github.com/acme/widgets/pull/42";
        session(
            &c,
            Provider::ClaudeCode,
            "p1",
            Some(&p),
            Some(at(1, 0)),
            json!({ "prUrl": url }),
        );
        session(
            &c,
            Provider::ClaudeCode,
            "p2",
            Some(&p),
            Some(at(2, 0)),
            json!({ "prUrl": url }),
        );
        session(
            &c,
            Provider::ClaudeCode,
            "p3",
            Some(&p),
            Some(at(2, 0)),
            json!({ "prUrl": "not a url" }),
        );
        let r = build(&c, &query(7, vec![])).unwrap();
        assert_eq!(r.pull_requests.len(), 1);
        assert_eq!(r.pull_requests[0].repo.as_deref(), Some("acme/widgets"));
        assert_eq!(r.pull_requests[0].number, Some(42));
        assert_eq!(r.projects[0].pull_requests, 1);
    }

    #[test]
    fn parses_pull_request_urls() {
        assert_eq!(
            parse_pr_url("https://github.com/o/r/pull/7?x=1"),
            Some((Some("o/r".into()), Some(7)))
        );
        assert_eq!(
            parse_pr_url("https://gitlab.com/g/p/-/merge_requests/3"),
            Some((None, Some(3)))
        );
        assert_eq!(parse_pr_url("file:///etc/passwd"), None);
        assert_eq!(parse_pr_url("https://"), None);
    }

    #[test]
    fn rejects_periods_longer_than_the_history() {
        let c = open_in_memory();
        assert!(build(&c, &query(120, vec![])).is_err());
        let mut backwards = query(7, vec![]);
        std::mem::swap(&mut backwards.since, &mut backwards.until);
        assert!(build(&c, &backwards).is_err());
    }

    #[test]
    fn outcomes_are_validated_dated_and_filtered() {
        let c = open_in_memory();
        let atlas = project(&c, "Atlas");
        let input = |text: &str, day: &str, project: Option<&str>| OutcomeInput {
            project_id: project.map(Into::into),
            text: text.into(),
            occurred_on: day.into(),
        };
        assert!(create_outcome(&c, &input("   ", "2026-09-20", None)).is_err());
        assert!(create_outcome(&c, &input(&"x".repeat(141), "2026-09-20", None)).is_err());
        assert!(create_outcome(&c, &input("ok", "20/09/2026", None)).is_err());
        assert!(create_outcome(&c, &input("ok", "2026-09-20", Some("nope"))).is_err());

        let o = create_outcome(
            &c,
            &input("  Shipped\n the  importer ", "2026-09-20", Some(&atlas)),
        )
        .unwrap();
        assert_eq!(o.text, "Shipped the importer");
        create_outcome(&c, &input("Wrote the launch post", "2026-09-22", None)).unwrap();
        create_outcome(&c, &input("Long ago", "2026-06-01", None)).unwrap();

        let r = build(&c, &query(7, vec![])).unwrap();
        assert_eq!(r.outcomes.len(), 2);
        assert_eq!(r.outcomes[0].text, "Wrote the launch post", "newest first");
        let only = build(&c, &query(7, vec![atlas.clone()])).unwrap();
        assert_eq!(only.outcomes.len(), 1);

        let edited = update_outcome(
            &c,
            &o.id,
            &input("Shipped the CSV importer", "2026-09-21", None),
        )
        .unwrap();
        assert_eq!(
            (edited.text.as_str(), edited.project_id),
            ("Shipped the CSV importer", None)
        );
        delete_outcome(&c, &o.id).unwrap();
        assert_eq!(build(&c, &query(7, vec![])).unwrap().outcomes.len(), 1);
    }

    #[test]
    fn outcomes_survive_project_deletion_but_not_demo_cleanup() {
        let c = open_in_memory();
        let real = project(&c, "Atlas");
        let o = create_outcome(
            &c,
            &OutcomeInput {
                project_id: Some(real.clone()),
                text: "Kept".into(),
                occurred_on: "2026-09-20".into(),
            },
        )
        .unwrap();
        db::delete_project(&c, &real).unwrap();
        let kept = get_outcome(&c, &o.id).unwrap().unwrap();
        assert_eq!(kept.project_id, None);

        let demo = db::create_project(
            &c,
            ProjectInput {
                name: "Demo · Vega".into(),
                root_path: None,
                icon: None,
                color: None,
                is_demo: true,
            },
        )
        .unwrap();
        create_outcome(
            &c,
            &OutcomeInput {
                project_id: Some(demo.id),
                text: "Demo outcome".into(),
                occurred_on: "2026-09-20".into(),
            },
        )
        .unwrap();
        db::clear_demo(&c).unwrap();
        let left = list_outcomes(&c, "2000-01-01", "2100-01-01").unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "Kept");
    }

    /// Uses a private, uniquely named pasteboard: the test never touches the real clipboard.
    #[cfg(target_os = "macos")]
    #[test]
    fn copies_a_png_to_a_pasteboard() {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
        let png = [PNG_SIGNATURE, b"rest"].concat();
        let pb = NSPasteboard::pasteboardWithUniqueName();
        write_png(&pb, &png).unwrap();
        let back = pb.dataForType(unsafe { NSPasteboardTypePNG }).unwrap();
        assert_eq!(back.to_vec(), png);
        // Free the private pasteboard (no generated binding for this one).
        let _: () = unsafe { objc2::msg_send![&*pb, releaseGlobally] };
        assert!(
            copy_png(b"not a png").is_err(),
            "rejected before the clipboard is touched"
        );
    }

    #[test]
    fn exports_only_pngs_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_png(dir.path(), b"not a png").is_err());
        let png = [PNG_SIGNATURE, b"rest"].concat();
        let a = save_png(dir.path(), &png).unwrap();
        let b = save_png(dir.path(), &png).unwrap();
        assert_ne!(a, b);
        assert!(b.file_name().unwrap().to_string_lossy().ends_with(" 2.png"));
        assert!(save_png(&dir.path().join("missing"), &png).is_err());
    }
}
