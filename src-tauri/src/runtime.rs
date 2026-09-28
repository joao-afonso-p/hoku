//! Runtime monitor: turns provider signals into normalized runtime state, applies watchdog
//! rules, and records semantic transitions for the Activity timeline. See
//! docs/runtime-state.md.
//!
//! Runs on its own thread every [`TICK`]. Provider probes happen without the hub DB lock; the
//! lock is taken briefly to read sessions and again to write what changed.

use crate::attention;
use crate::db;
use crate::models::*;
use crate::providers::{Observation, RuntimeTarget, SessionAdapter};
use crate::scan;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const TICK: Duration = Duration::from_secs(4);
/// Working with no provider activity for this long is no longer believable → Unknown.
pub const WORKING_STALE_MIN: i64 = 20;
/// Ready is "recently finished". After this it quietly becomes Idle.
pub const READY_TTL_MIN: i64 = 45;
/// A failed turn nobody followed up on stops shouting after this.
pub const ERROR_TTL_MIN: i64 = 6 * 60;
/// The same event type for a session within this window is recorded once.
const EVENT_DEDUPE_SECS: i64 = 120;
pub const EVENT_RETENTION_DAYS: i64 = 90;
/// How often an unchanged state gets its `lastObservedAt` refreshed.
const HEARTBEAT: Duration = Duration::from_secs(60);
/// Minimum gap between automatic discoveries for one adapter.
const DISCOVERY_GAP: Duration = Duration::from_secs(8);
/// How long before a live-but-unindexable session is looked for again.
const DISCOVERY_RETRY: Duration = Duration::from_secs(15);
/// Recency bumps from runtime activity are written at most this often per session.
const ACTIVITY_BUMP_SECS: i64 = 60;

#[derive(Default)]
pub struct MonitorState {
    last_heartbeat: Option<Instant>,
    last_prune: Option<Instant>,
    last_discovery: HashMap<&'static str, Instant>,
    /// Live ids a discovery already looked for, and when. A terminal with no prompt yet has no
    /// transcript to index, so it's retried after [`DISCOVERY_RETRY`], not every tick.
    attempted: HashMap<String, Instant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub session_id: String,
    pub provider: Provider,
    pub from: RuntimeState,
    pub to: RuntimeState,
    pub event: Option<String>,
    pub action_required: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickOutcome {
    pub changed: bool,
    pub transitions: Vec<Transition>,
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse(t: Option<&str>) -> Option<DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(t?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn older_than(t: Option<&str>, now: DateTime<Utc>, minutes: i64) -> bool {
    parse(t)
        .map(|t| now - t > ChronoDuration::minutes(minutes))
        .unwrap_or(false)
}

/// Watchdog rules, applied to every fresh observation. `since` is when the state began.
pub fn settle(mut o: Observation, since: Option<&str>, now: DateTime<Utc>) -> Observation {
    match o.state {
        RuntimeState::Working if older_than(o.activity_at.as_deref(), now, WORKING_STALE_MIN) => {
            o.state = RuntimeState::Unknown;
            o.confidence = Confidence::Low;
            o.reason = Some("Marked working, but no activity for a while".into());
        }
        RuntimeState::Ready if older_than(since, now, READY_TTL_MIN) => {
            o.state = RuntimeState::Idle;
            o.reason = Some("Finished earlier".into());
        }
        RuntimeState::Error if older_than(since, now, ERROR_TTL_MIN) => {
            o.state = RuntimeState::Idle;
            o.reason = Some("An earlier turn failed".into());
            o.action_required = false;
        }
        _ => {}
    }
    o
}

/// Which semantic event (if any) a transition deserves. Low-level churn is not recorded.
/// `bootstrap` = the session had never been evaluated (first launch, fresh import).
pub fn event_for(from: RuntimeState, to: RuntimeState, bootstrap: bool) -> Option<&'static str> {
    use RuntimeState::*;
    if bootstrap {
        return match to {
            NeedsInput => Some("needs_input"),
            Working => Some("started_working"),
            Ready => Some("became_ready"),
            Error => Some("error"),
            _ => None,
        };
    }
    if from == to {
        return None;
    }
    match (from, to) {
        (NeedsInput, Working) => Some("resumed"),
        (_, Working) => Some("started_working"),
        (_, NeedsInput) => Some("needs_input"),
        (_, Ready) => Some("became_ready"),
        (_, Error) => Some("error"),
        (Working | NeedsInput, Idle) => Some("became_idle"),
        (Offline | Unknown, Idle) => Some("opened"),
        (Working | NeedsInput | Ready | Idle | Error, Offline) => Some("went_offline"),
        _ => None,
    }
}

fn same(a: &RuntimeStatus, b: &RuntimeStatus) -> bool {
    a.state == b.state
        && a.confidence == b.confidence
        && a.reason == b.reason
        && a.detail == b.detail
        && a.source == b.source
        && a.action_required == b.action_required
        && a.since == b.since
}

/// The static answer for sessions no adapter can observe (Claude chats, manual oddities).
fn unobservable(s: &Session) -> Observation {
    let reason = if s.provider == Provider::Claude {
        "Claude chats have no local live state"
    } else {
        "No live signal for this session"
    };
    Observation::new(RuntimeState::Unknown, Confidence::Low, "none").reason(reason)
}

pub fn tick(
    db: &Mutex<Connection>,
    adapters: &[Box<dyn SessionAdapter>],
    st: &mut MonitorState,
) -> TickOutcome {
    let now = Utc::now();
    let now_iso = iso(now);
    let sessions = match db::list_sessions(&db.lock().expect("db")) {
        Ok(s) => s,
        Err(_) => return TickOutcome::default(),
    };
    let real: Vec<&Session> = sessions
        .iter()
        .filter(|s| s.source.as_deref() != Some("demo"))
        .collect();

    // 1. Probe providers (no DB lock held).
    let mut observed: Vec<(&Session, Observation)> = Vec::with_capacity(real.len());
    let mut owned: HashSet<&str> = HashSet::new();
    let mut discover: Vec<&'static str> = Vec::new();
    for adapter in adapters {
        let mine: Vec<&Session> = real
            .iter()
            .copied()
            .filter(|s| !owned.contains(s.id.as_str()) && adapter.owns_runtime(s))
            .collect();
        owned.extend(mine.iter().map(|s| s.id.as_str()));
        let targets: Vec<RuntimeTarget> = mine
            .iter()
            .filter_map(|s| {
                Some(RuntimeTarget {
                    external_id: s.external_id.as_deref()?,
                    working_directory: s.working_directory.as_deref(),
                    metadata: s.metadata.as_ref(),
                })
            })
            .collect();
        let Some(probe) = adapter.runtime(&targets) else {
            continue;
        };
        let fresh: Vec<&String> = probe
            .unindexed_live
            .iter()
            .filter(|id| {
                st.attempted
                    .get(*id)
                    .map(|t| t.elapsed() > DISCOVERY_RETRY)
                    .unwrap_or(true)
            })
            .collect();
        if !fresh.is_empty()
            && st
                .last_discovery
                .get(adapter.key())
                .map(|t| t.elapsed() > DISCOVERY_GAP)
                .unwrap_or(true)
        {
            let at = Instant::now();
            for id in fresh {
                st.attempted.insert(id.clone(), at);
            }
            discover.push(adapter.key());
        }
        for s in mine {
            let obs = s
                .external_id
                .as_deref()
                .and_then(|e| probe.observations.get(e))
                .cloned()
                .unwrap_or_else(|| probe.fallback.clone());
            observed.push((s, obs));
        }
    }
    for s in real.iter().filter(|s| !owned.contains(s.id.as_str())) {
        observed.push((s, unobservable(s)));
    }

    // 2. Settle and diff.
    let mut out = TickOutcome::default();
    let mut writes: Vec<(
        &Session,
        RuntimeStatus,
        Option<&'static str>,
        Option<String>,
    )> = Vec::new();
    let mut bumps: Vec<(&str, String)> = Vec::new();
    for (s, obs) in observed {
        let prev = &s.runtime;
        let since = obs
            .since
            .clone()
            .or_else(|| {
                (obs.state == prev.state)
                    .then(|| prev.since.clone())
                    .flatten()
            })
            .or_else(|| Some(now_iso.clone()));
        let o = settle(obs, since.as_deref(), now);
        let since = if o.state == prev.state && o.since.is_none() {
            prev.since.clone().or(since)
        } else {
            o.since.clone().or(since)
        };
        let next = RuntimeStatus {
            state: o.state,
            confidence: o.confidence,
            reason: o.reason.clone(),
            detail: o.detail.clone(),
            source: Some(o.source.to_string()),
            action_required: o.action_required,
            since,
            last_observed_at: Some(now_iso.clone()),
        };
        if let Some(at) = &o.activity_at {
            let due = match (parse(s.last_activity_at.as_deref()), parse(Some(at))) {
                (Some(last), Some(a)) => (a - last).num_seconds() >= ACTIVITY_BUMP_SECS,
                (None, Some(_)) => true,
                _ => false,
            };
            if due {
                bumps.push((s.id.as_str(), at.clone()));
            }
        }
        if same(prev, &next) {
            continue;
        }
        // A session that appeared while Hoku watched (new terminal, new thread) reads as "opened";
        // anything else seen for the first time only records what matters now.
        let bootstrap = prev.source.is_none();
        let just_appeared = parse(Some(&s.created_at))
            .map(|c| now - c < ChronoDuration::minutes(5))
            .unwrap_or(false)
            && !older_than(next.since.as_deref(), now, 10);
        let event = if bootstrap && just_appeared {
            event_for(RuntimeState::Offline, next.state, false)
        } else {
            event_for(prev.state, next.state, bootstrap)
        };
        // Timestamp: when the state began if the provider told us (and it's plausible), else now.
        let at = next
            .since
            .clone()
            .filter(|t| parse(Some(t)).map(|t| t <= now).unwrap_or(false))
            .filter(|_| event.is_some());
        if prev.state != next.state && (event.is_some() || next.action_required) {
            out.transitions.push(Transition {
                session_id: s.id.clone(),
                provider: s.provider,
                from: prev.state,
                to: next.state,
                event: event.map(str::to_string),
                action_required: next.action_required,
            });
        }
        writes.push((s, next, event, at));
    }

    // 3. Persist.
    {
        let c = db.lock().expect("db");
        if !writes.is_empty() {
            let _ = c.execute_batch("BEGIN");
            for (s, next, event, at) in &writes {
                if db::write_runtime(&c, &s.id, next).is_err() {
                    continue;
                }
                if let Some(kind) = event {
                    let last = db::last_event(&c, &s.id).ok().flatten();
                    // A provider's "since" can predate what we last recorded; keep the timeline ordered.
                    let mut ts = at.clone().unwrap_or_else(|| now_iso.clone());
                    if let Some(prev) = last.as_ref().filter(|e| e.timestamp > ts) {
                        ts = prev.timestamp.clone();
                    }
                    let dup = last.map(|e| {
                        e.event_type == *kind
                            && parse(Some(&e.timestamp))
                                .map(|t| {
                                    (parse(Some(&ts)).unwrap_or(now) - t).num_seconds().abs()
                                        < EVENT_DEDUPE_SECS
                                })
                                .unwrap_or(false)
                    });
                    if dup != Some(true) {
                        let _ = db::insert_event(
                            &c,
                            &ActivityEvent {
                                id: db::new_id(),
                                session_id: s.id.clone(),
                                event_type: kind.to_string(),
                                provider: s.provider,
                                timestamp: ts,
                                title: Some(s.title.clone()),
                                from_state: Some(s.runtime.state),
                                to_state: Some(next.state),
                                reason: next.reason.clone(),
                                metadata: next.detail.as_ref().map(|d| serde_json::json!({ "detail": d, "confidence": next.confidence })),
                            },
                        );
                    }
                }
            }
            let _ = c.execute_batch("COMMIT");
            out.changed = true;
        }
        for (id, at) in &bumps {
            let _ = db::bump_last_activity(&c, id, at);
        }
        if st
            .last_heartbeat
            .map(|t| t.elapsed() > HEARTBEAT)
            .unwrap_or(true)
        {
            let ids: Vec<String> = real.iter().map(|s| s.id.clone()).collect();
            let _ = c.execute_batch("BEGIN");
            let _ = db::touch_runtime(&c, &ids, &now_iso);
            let _ = c.execute_batch("COMMIT");
            st.last_heartbeat = Some(Instant::now());
        }
        if st
            .last_prune
            .map(|t| t.elapsed() > Duration::from_secs(6 * 3600))
            .unwrap_or(true)
        {
            let _ = db::prune_events(&c, &iso(now - ChronoDuration::days(EVENT_RETENTION_DAYS)));
            st.last_prune = Some(Instant::now());
        }
    }

    // 4. New live sessions the index doesn't know yet: a quick, adapter-scoped discovery.
    if !discover.is_empty() {
        let keys: Vec<String> = discover.iter().map(|k| k.to_string()).collect();
        for k in &discover {
            st.last_discovery.insert(k, Instant::now());
        }
        let report = scan::run_scan(db, adapters, Some(&keys), &scan::AccountHints::new());
        if report.results.iter().any(|r| r.new > 0) {
            out.changed = true;
            // Evaluate the newcomers right away rather than on the next tick.
            let again = tick(db, adapters, st);
            out.transitions.extend(again.transitions);
        }
    }
    out
}

/// Where transitions leave the monitor, after every pass: a UI event when something changed,
/// then the Needs You alerts outside the window (banners, Dock badge, bounce). The alerts diff
/// the whole Needs You set rather than these transitions, so sessions that change through
/// other paths (a scan, a deletion, demo data) are counted too. See attention.rs.
fn announce(
    app: &tauri::AppHandle,
    outcome: &TickOutcome,
    db: &Mutex<Connection>,
    attention: &Mutex<attention::Tracker>,
) {
    use tauri::Emitter;
    if outcome.changed {
        let _ = app.emit("hub://runtime", outcome);
    }
    attention::reconcile(app, db, attention);
}

pub fn start(
    app: tauri::AppHandle,
    db: Arc<Mutex<Connection>>,
    adapters: Arc<Vec<Box<dyn SessionAdapter>>>,
    state: Arc<Mutex<MonitorState>>,
    attention: Arc<Mutex<attention::Tracker>>,
) {
    std::thread::Builder::new()
        .name("hoku-runtime".into())
        .spawn(move || loop {
            let outcome = {
                let mut st = state.lock().expect("monitor");
                tick(&db, &adapters, &mut st)
            };
            announce(&app, &outcome, &db, &attention);
            std::thread::sleep(TICK);
        })
        .expect("runtime monitor thread");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, upsert_discovered};
    use crate::providers::{RuntimeCapabilities, RuntimeProbe, ScanOutcome};
    use std::sync::Mutex as StdMutex;

    fn at(min_ago: i64) -> String {
        iso(Utc::now() - ChronoDuration::minutes(min_ago))
    }

    /// Real providers on this Mac, into an in-memory hub: `cargo test probe_this_mac -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn probe_this_mac() {
        let db = StdMutex::new(open_in_memory());
        let adapters = crate::providers::all_adapters();
        scan::run_scan(&db, &adapters, None, &scan::AccountHints::new());
        let mut st = MonitorState::default();
        tick(&db, &adapters, &mut st);
        let sessions = db::list_sessions(&db.lock().unwrap()).unwrap();
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for s in &sessions {
            *counts.entry(s.runtime.state.as_str()).or_default() += 1;
            if s.runtime.state != RuntimeState::Offline {
                println!(
                    "{:<11} {:<12} {:<6} {:<44} {} {}",
                    s.provider.as_str(),
                    s.runtime.state.as_str(),
                    s.runtime.confidence.as_str(),
                    crate::providers::text::truncate(&s.title, 42),
                    s.runtime.reason.as_deref().unwrap_or(""),
                    s.runtime
                        .detail
                        .as_deref()
                        .map(|d| format!("· {}", crate::providers::text::truncate(d, 50)))
                        .unwrap_or_default()
                );
            }
        }
        println!("{counts:?}");
        for e in db::list_events(&db.lock().unwrap(), "2000", 50).unwrap() {
            println!(
                "event {} {} {}",
                e.timestamp,
                e.event_type,
                e.title.unwrap_or_default()
            );
        }
    }

    #[test]
    fn stale_working_becomes_unknown() {
        let o =
            Observation::new(RuntimeState::Working, Confidence::High, "t").activity(Some(at(25)));
        let s = settle(o, None, Utc::now());
        assert_eq!(
            (s.state, s.confidence),
            (RuntimeState::Unknown, Confidence::Low)
        );
        let o =
            Observation::new(RuntimeState::Working, Confidence::High, "t").activity(Some(at(2)));
        assert_eq!(settle(o, None, Utc::now()).state, RuntimeState::Working);
    }

    #[test]
    fn ready_decays_to_idle_but_needs_input_never_times_out() {
        let ready = Observation::new(RuntimeState::Ready, Confidence::High, "t");
        assert_eq!(
            settle(ready.clone(), Some(&at(10)), Utc::now()).state,
            RuntimeState::Ready
        );
        assert_eq!(
            settle(ready, Some(&at(90)), Utc::now()).state,
            RuntimeState::Idle
        );
        let waiting = Observation::new(RuntimeState::NeedsInput, Confidence::High, "t");
        let s = settle(waiting, Some(&at(60 * 24 * 3)), Utc::now());
        assert_eq!(s.state, RuntimeState::NeedsInput);
        assert!(s.action_required);
    }

    #[test]
    fn transitions_map_to_semantic_events() {
        use RuntimeState::*;
        assert_eq!(event_for(Idle, Working, false), Some("started_working"));
        assert_eq!(event_for(NeedsInput, Working, false), Some("resumed"));
        assert_eq!(event_for(Working, NeedsInput, false), Some("needs_input"));
        assert_eq!(event_for(Working, Ready, false), Some("became_ready"));
        assert_eq!(
            event_for(Ready, Idle, false),
            None,
            "ready decaying is not news"
        );
        assert_eq!(event_for(Idle, Offline, false), Some("went_offline"));
        assert_eq!(event_for(Unknown, Offline, false), None);
        // First evaluation: only what matters, never a flood of "offline".
        assert_eq!(event_for(Unknown, Offline, true), None);
        assert_eq!(event_for(Unknown, Idle, true), None);
        assert_eq!(event_for(Unknown, Ready, true), Some("became_ready"));
        assert_eq!(event_for(Unknown, NeedsInput, true), Some("needs_input"));
    }

    /// A fake adapter whose next observation the test controls.
    struct Fake(Arc<StdMutex<Option<Observation>>>);
    impl SessionAdapter for Fake {
        fn key(&self) -> &'static str {
            "fake"
        }
        fn provider(&self) -> Provider {
            Provider::Codex
        }
        fn label(&self) -> &'static str {
            "Fake"
        }
        fn scan(&self) -> Result<ScanOutcome, HubError> {
            Ok(ScanOutcome::Found(vec![]))
        }
        fn runtime(&self, targets: &[RuntimeTarget]) -> Option<RuntimeProbe> {
            let obs = self.0.lock().unwrap().clone()?;
            Some(RuntimeProbe {
                observations: targets
                    .iter()
                    .map(|t| (t.external_id.to_string(), obs.clone()))
                    .collect(),
                fallback: Observation::new(RuntimeState::Offline, Confidence::High, "fake"),
                unindexed_live: vec![],
            })
        }
        fn runtime_capabilities(&self) -> RuntimeCapabilities {
            RuntimeCapabilities::none("test")
        }
    }

    #[test]
    fn monitor_records_transitions_once() {
        let conn = open_in_memory();
        let d = DiscoveredSession {
            external_id: "t1".into(),
            title: "Calendar integration".into(),
            ..Default::default()
        };
        upsert_discovered(&conn, Provider::Codex, "fake", &d, None, None).unwrap();
        // Pretend it was imported long ago, so the first evaluation is a quiet bootstrap.
        conn.execute(
            "UPDATE sessions SET created_at = '2026-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        let db = StdMutex::new(conn);
        let next = Arc::new(StdMutex::new(Some(Observation::new(
            RuntimeState::Idle,
            Confidence::Medium,
            "fake",
        ))));
        let adapters: Vec<Box<dyn SessionAdapter>> = vec![Box::new(Fake(next.clone()))];
        let mut st = MonitorState::default();
        let set = |o: Observation| *next.lock().unwrap() = Some(o);

        let o = tick(&db, &adapters, &mut st);
        assert!(o.changed);
        let events =
            |db: &StdMutex<Connection>| db::list_events(&db.lock().unwrap(), "2000", 100).unwrap();
        assert!(events(&db).is_empty(), "bootstrap to idle records nothing");

        set(
            Observation::new(RuntimeState::Working, Confidence::Medium, "fake")
                .activity(Some(at(0))),
        );
        tick(&db, &adapters, &mut st);
        set(
            Observation::new(RuntimeState::NeedsInput, Confidence::Medium, "fake")
                .reason("Waiting for approval")
                .since(Some(at(1))),
        );
        let o = tick(&db, &adapters, &mut st);
        assert_eq!(o.transitions[0].to, RuntimeState::NeedsInput);
        assert!(o.transitions[0].action_required);
        // Unchanged: nothing written, nothing recorded.
        assert!(!tick(&db, &adapters, &mut st).changed);
        set(Observation::new(RuntimeState::Ready, Confidence::Medium, "fake").since(Some(at(0))));
        tick(&db, &adapters, &mut st);

        let kinds: Vec<String> = events(&db)
            .into_iter()
            .rev()
            .map(|e| e.event_type)
            .collect();
        assert_eq!(
            kinds,
            vec!["started_working", "needs_input", "became_ready"]
        );
        let s = db::list_sessions(&db.lock().unwrap()).unwrap().remove(0);
        assert_eq!(s.runtime.state, RuntimeState::Ready);
        assert_eq!(s.runtime.source.as_deref(), Some("fake"));
    }

    /// An approval is persisted as needs_input with action required, survives unchanged ticks
    /// and the watchdog, and leaving it is persisted and announced as "resumed".
    #[test]
    fn needs_input_is_persisted_and_left_cleanly() {
        let conn = open_in_memory();
        let d = DiscoveredSession {
            external_id: "t1".into(),
            title: "Release".into(),
            ..Default::default()
        };
        upsert_discovered(&conn, Provider::Codex, "fake", &d, None, None).unwrap();
        conn.execute(
            "UPDATE sessions SET created_at = '2026-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        let db = StdMutex::new(conn);
        let next = Arc::new(StdMutex::new(Some(
            Observation::new(RuntimeState::Working, Confidence::Medium, "fake")
                .activity(Some(at(0))),
        )));
        let adapters: Vec<Box<dyn SessionAdapter>> = vec![Box::new(Fake(next.clone()))];
        let mut st = MonitorState::default();
        let stored = |db: &StdMutex<Connection>| {
            db::list_sessions(&db.lock().unwrap())
                .unwrap()
                .remove(0)
                .runtime
        };
        tick(&db, &adapters, &mut st);
        assert_eq!(stored(&db).state, RuntimeState::Working);

        // Waiting an hour: no activity, but needs_input has no watchdog.
        *next.lock().unwrap() = Some(
            Observation::new(RuntimeState::NeedsInput, Confidence::Medium, "fake")
                .reason("Waiting for approval")
                .detail(Some("Allow creating the pull request?".into()))
                .since(Some(at(60))),
        );
        let o = tick(&db, &adapters, &mut st);
        assert!(o.changed);
        assert_eq!(
            (o.transitions[0].to, o.transitions[0].event.as_deref()),
            (RuntimeState::NeedsInput, Some("needs_input"))
        );
        let rt = stored(&db);
        assert_eq!(
            (rt.state, rt.action_required, rt.detail.as_deref()),
            (
                RuntimeState::NeedsInput,
                true,
                Some("Allow creating the pull request?")
            )
        );
        assert!(!tick(&db, &adapters, &mut st).changed);
        assert_eq!(stored(&db).state, RuntimeState::NeedsInput);

        // Approved: the command runs.
        *next.lock().unwrap() = Some(
            Observation::new(RuntimeState::Working, Confidence::Medium, "fake")
                .activity(Some(at(0))),
        );
        let o = tick(&db, &adapters, &mut st);
        assert_eq!(
            (o.transitions[0].from, o.transitions[0].to),
            (RuntimeState::NeedsInput, RuntimeState::Working)
        );
        assert_eq!(o.transitions[0].event.as_deref(), Some("resumed"));
        let rt = stored(&db);
        assert_eq!(
            (rt.state, rt.action_required),
            (RuntimeState::Working, false)
        );
    }
}
