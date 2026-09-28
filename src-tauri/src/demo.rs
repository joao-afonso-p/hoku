//! Demo constellation for exercising layout density. Always tagged: projects have
//! `is_demo = 1`, sessions have `source = 'demo'`. Demo sessions cannot be opened.

use crate::db::{self, ManualSessionInput, ProjectInput};
use crate::models::{ActivityEvent, Confidence, HubResult, Provider, RuntimeState, RuntimeStatus};
use rusqlite::Connection;
use serde_json::json;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f64) / (u32::MAX as f64 / 2.0)
    }
}

const SYSTEMS: &[(&str, &str, usize)] = &[
    ("Demo · Vega", "#8ea8e0", 34),
    ("Demo · Lyra", "#d9a066", 9),
    ("Demo · Orion", "#b39ae0", 4),
];

const TOPICS: &[&str] = &[
    "Backup / DR",
    "Evaluation pipeline",
    "Mobile redesign",
    "Auth refactor",
    "Product vision",
    "Architecture",
    "Obsidian sync",
    "Pricing page",
    "Search ranking",
    "Onboarding flow",
    "Billing webhooks",
    "Release notes",
    "Data export",
    "Latency budget",
    "Design tokens",
    "Offline mode",
    "Error taxonomy",
    "Migration plan",
];

/// A believable spread of runtime states: a few need you, some work, most are offline.
fn demo_runtime(
    system: usize,
    i: usize,
    provider: Provider,
    minutes_ago: i64,
) -> (
    RuntimeState,
    Option<&'static str>,
    Option<&'static str>,
    bool,
) {
    use RuntimeState::*;
    match (system, i) {
        (0, 0) => (
            NeedsInput,
            Some("Waiting for permission"),
            Some("Bash"),
            true,
        ),
        (0, 1) => (Working, Some("Running Edit"), None, false),
        (0, 2) => (Ready, Some("Finished its turn"), None, false),
        (0, 3) => (Idle, Some("Open, no prompt yet"), None, false),
        (0, 4) => (
            Error,
            Some("Authentication required"),
            Some("Please run /login"),
            true,
        ),
        (0, 5) => (Working, Some("Generating"), None, false),
        (0, 6) => (
            Error,
            Some("Usage limit reached"),
            Some("You've hit your session limit"),
            false,
        ),
        (1, 0) => (
            NeedsInput,
            Some("Waiting for approval"),
            Some("Allow a read-only check on the server?"),
            true,
        ),
        (1, 1) => (Working, Some("Turn in progress"), None, false),
        (1, 2) => (Ready, Some("Finished its turn"), None, false),
        (2, 0) => (
            NeedsInput,
            Some("Asked a question"),
            Some("Which test framework should we use?"),
            true,
        ),
        _ if provider == Provider::Claude && i % 5 == 0 => (
            Unknown,
            Some("Claude chats have no local live state"),
            None,
            false,
        ),
        _ if minutes_ago < 90 && i % 4 == 0 => (Idle, Some("Open"), None, false),
        _ => (Offline, Some("Demo · not connected"), None, false),
    }
}

fn demo_event(
    conn: &Connection,
    session_id: &str,
    provider: Provider,
    title: &str,
    kind: &str,
    at: chrono::DateTime<chrono::Utc>,
    to: RuntimeState,
    reason: Option<&str>,
) -> HubResult<()> {
    db::insert_event(
        conn,
        &ActivityEvent {
            id: db::new_id(),
            session_id: session_id.into(),
            event_type: kind.into(),
            provider,
            timestamp: at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            title: Some(title.into()),
            from_state: None,
            to_state: Some(to),
            reason: reason.map(Into::into),
            metadata: Some(json!({ "demo": true })),
        },
    )?;
    Ok(())
}

pub fn load(conn: &Connection) -> HubResult<()> {
    db::clear_demo(conn)?;
    let mut rng = Lcg(42);
    let now = chrono::Utc::now();
    for (system, (name, color, count)) in SYSTEMS.iter().enumerate() {
        let project = db::create_project(
            conn,
            ProjectInput {
                name: (*name).into(),
                root_path: None,
                icon: None,
                color: Some((*color).into()),
                is_demo: true,
            },
        )?;
        // One demo project shows a filled-in Resume; the others show its empty states.
        if system == 0 {
            db::update_project_resume(
                conn,
                &project.id,
                Some(Some("Demo · A web app for tracking team goals. Current focus: auth refactor and the evaluation pipeline.".into())),
                Some(Some("Approve the pending Bash permission, then review the auth refactor branch.".into())),
            )?;
        }
        for i in 0..*count {
            let provider = match (rng.next() * 3.0) as u32 {
                0 => Provider::ClaudeCode,
                1 => Provider::Claude,
                _ => Provider::Codex,
            };
            // Skew ages towards recent, with a long tail.
            let hours = (rng.next().powf(2.4) * 24.0 * 60.0) as i64;
            let (state, reason, detail, action) = demo_runtime(system, i, provider, hours * 60);
            // Live demo sessions were active minutes ago; the rest keep their long-tail age.
            let minutes = if state.is_live() {
                2 + (rng.next() * 25.0) as i64
            } else {
                hours * 60
            };
            let at = now - chrono::Duration::minutes(minutes);
            let since = at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let topic = TOPICS[(rng.next() * TOPICS.len() as f64) as usize % TOPICS.len()];
            let title = if i < TOPICS.len() {
                topic.to_string()
            } else {
                format!("{topic} {}", i / TOPICS.len() + 1)
            };
            let session = db::insert_manual_session(
                conn,
                ManualSessionInput {
                    provider,
                    external_id: None,
                    title: title.clone(),
                    project_id: Some(project.id.clone()),
                    provider_account_id: None,
                    working_directory: None,
                    deep_link: None,
                    source_url: None,
                    notes: None,
                    source: "demo".into(),
                    metadata: Some(
                        json!({ "demo": true, "userTurns": (rng.next() * 60.0) as i64 }),
                    ),
                    last_activity_at: Some(since.clone()),
                    runtime: Some(RuntimeStatus {
                        state,
                        confidence: Confidence::High,
                        reason: reason.map(Into::into),
                        detail: detail.map(Into::into),
                        source: Some("demo".into()),
                        action_required: action,
                        since: Some(since.clone()),
                        last_observed_at: Some(
                            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        ),
                    }),
                    favorite: rng.next() > 0.9,
                },
            )?;
            // A few sessions carry a branch, a PR and a note, like real ones do.
            if system == 0 && i < 5 {
                let branch = [
                    "feat/auth-refactor",
                    "fix/eval-flakes",
                    "feat/eval-pipeline",
                    "main",
                    "chore/tokens",
                ][i];
                let note = match i {
                    0 => Some("Demo note · Needs a decision on running the migration script."),
                    2 => Some("Demo note · Check the eval numbers before merging."),
                    _ => None,
                };
                conn.execute(
                    "UPDATE sessions SET branch = ?2, notes = COALESCE(?3, notes),
                        metadata = CASE WHEN ?4 IS NULL THEN metadata ELSE json_set(metadata, '$.prUrl', ?4) END
                     WHERE id = ?1",
                    rusqlite::params![
                        session.id,
                        branch,
                        note,
                        (i == 2).then_some("https://github.com/example/demo/pull/128")
                    ],
                )?;
            }
            // A short history, so the Activity timeline has something to show.
            let id = &session.id;
            match state {
                RuntimeState::Working => demo_event(
                    conn,
                    id,
                    provider,
                    &title,
                    "started_working",
                    at,
                    state,
                    reason,
                )?,
                RuntimeState::NeedsInput => {
                    demo_event(
                        conn,
                        id,
                        provider,
                        &title,
                        "started_working",
                        at - chrono::Duration::minutes(9),
                        RuntimeState::Working,
                        None,
                    )?;
                    demo_event(conn, id, provider, &title, "needs_input", at, state, reason)?;
                }
                RuntimeState::Ready => {
                    demo_event(
                        conn,
                        id,
                        provider,
                        &title,
                        "started_working",
                        at - chrono::Duration::minutes(21),
                        RuntimeState::Working,
                        None,
                    )?;
                    demo_event(
                        conn,
                        id,
                        provider,
                        &title,
                        "became_ready",
                        at,
                        state,
                        reason,
                    )?;
                }
                RuntimeState::Error => {
                    demo_event(conn, id, provider, &title, "error", at, state, reason)?
                }
                RuntimeState::Offline if hours < 72 => {
                    demo_event(
                        conn,
                        id,
                        provider,
                        &title,
                        "became_ready",
                        at,
                        RuntimeState::Ready,
                        None,
                    )?;
                    demo_event(
                        conn,
                        id,
                        provider,
                        &title,
                        "went_offline",
                        at + chrono::Duration::minutes(40),
                        state,
                        None,
                    )?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}
