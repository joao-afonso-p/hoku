//! Needs You outside the window: native notification banners, the Dock badge and an optional
//! Dock bounce. See docs/runtime-state.md ("Notifications and the Dock").
//!
//! The runtime monitor calls [`reconcile`] after every pass. It diffs the *set* of sessions
//! that need you against the previous pass ([`Tracker::step`], pure and tested), so a session
//! alerts once per Needs You episode however often the monitor re-observes it. Only the
//! `native` module touches AppKit and UserNotifications, and its UI work always runs on the
//! main thread through `run_on_main_thread`.
//!
//! Alerts are local notifications posted by this process: they exist only while Hoku runs.
//! Nothing is pushed, and nothing leaves the Mac.

use crate::db::{self, NeedsYouRow};
use crate::models::{Provider, RuntimeState};
use crate::providers::text;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Settings keys (the `settings` table), mirrored in src/features/settings/notifications.ts.
pub const BANNERS_KEY: &str = "notifications.needsYou";
pub const BADGE_KEY: &str = "notifications.dockBadge";
pub const BOUNCE_KEY: &str = "notifications.dockBounce";

/// A session that comes back into Needs You this soon after leaving it is the same episode
/// flapping (or someone already answering prompts at the terminal): no second alert.
pub const REENTRY_QUIET: Duration = Duration::from_secs(60);
/// More new sessions than this in one pass become a single summary banner.
pub const MAX_BANNERS: usize = 3;

const ID_PREFIX: &str = "needs-you:";
const SUMMARY_ID: &str = "needs-you:summary";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prefs {
    /// Post a banner when a session starts needing you. Off until turned on in Settings,
    /// which is where macOS asks for permission.
    pub banners: bool,
    /// Show the Needs You count on the Dock icon.
    pub badge: bool,
    /// Bounce the Dock icon once when a session starts needing you.
    pub bounce: bool,
}

impl Prefs {
    pub fn from_settings(s: &Map<String, Value>) -> Self {
        let flag = |k: &str, default: bool| s.get(k).and_then(Value::as_bool).unwrap_or(default);
        Prefs {
            banners: flag(BANNERS_KEY, false),
            badge: flag(BADGE_KEY, true),
            bounce: flag(BOUNCE_KEY, false),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Banner {
    /// Also the click target: `needs-you:<session id>` or `needs-you:summary`. Reposting the
    /// same id replaces the old banner instead of stacking another.
    pub id: String,
    pub title: String,
    pub body: String,
}

/// What one pass changes outside the window.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The Dock badge label, `None` to clear it.
    pub badge: Option<String>,
    pub banners: Vec<Banner>,
    pub bounce: bool,
    pub cancel_bounce: bool,
    /// Delivered banners to take back from Notification Center: they no longer need you.
    pub withdraw: Vec<String>,
    /// First pass only: withdraw every delivered Needs You banner except these ids, which
    /// clears banners a previous run left behind for sessions that were answered since.
    pub keep_only: Option<Vec<String>>,
}

#[derive(Debug, Default)]
pub struct Tracker {
    primed: bool,
    /// Sessions in Needs You as of the last pass.
    open: HashSet<String>,
    /// When a session last left Needs You (for [`REENTRY_QUIET`]).
    left_at: HashMap<String, Instant>,
    badge: Option<String>,
    bouncing: bool,
}

impl Tracker {
    /// Whether the first pass after launch has run. Only the monitor should prime the tracker:
    /// that pass follows a fresh runtime tick, so stale persisted states aren't taken as news.
    pub fn primed(&self) -> bool {
        self.primed
    }

    /// Diff this pass against the last and decide what to show. `foreground` = Hoku's window
    /// is in front and focused, so the in-app badge already shows the work. Returns `None`
    /// when nothing outside the window needs to change.
    pub fn step(
        &mut self,
        rows: &[NeedsYouRow],
        prefs: Prefs,
        foreground: bool,
        now: Instant,
    ) -> Option<Plan> {
        let current: HashSet<String> = rows.iter().map(|r| r.session_id.clone()).collect();
        let badge = (prefs.badge && !current.is_empty()).then(|| current.len().to_string());

        // Launch: whatever already waits is shown on the Dock, never replayed as banners.
        if !self.primed {
            self.primed = true;
            self.open = current;
            self.badge = badge.clone();
            let mut keep: Vec<String> = self.open.iter().map(|id| banner_id(id)).collect();
            if !keep.is_empty() {
                keep.push(SUMMARY_ID.into());
            }
            keep.sort();
            return Some(Plan {
                badge,
                keep_only: Some(keep),
                ..Plan::default()
            });
        }

        let mut left: Vec<String> = self.open.difference(&current).cloned().collect();
        left.sort();
        for id in &left {
            self.left_at.insert(id.clone(), now);
        }
        self.left_at
            .retain(|_, t| now.saturating_duration_since(*t) < REENTRY_QUIET);
        let fresh: Vec<&NeedsYouRow> = rows
            .iter()
            .filter(|r| !self.open.contains(&r.session_id))
            .filter(|r| !r.demo && !self.left_at.contains_key(&r.session_id))
            .collect();
        let had_any = !self.open.is_empty();
        self.open = current;

        let mut plan = Plan {
            badge,
            ..Plan::default()
        };
        let alert = !fresh.is_empty() && !foreground;
        if alert && prefs.banners {
            plan.banners = banners(&fresh, rows.len());
        }
        if alert && prefs.bounce {
            plan.bounce = true;
            self.bouncing = true;
        } else if self.bouncing && (rows.is_empty() || foreground) {
            plan.cancel_bounce = true;
            self.bouncing = false;
        }
        plan.withdraw = left.iter().map(|id| banner_id(id)).collect();
        if rows.is_empty() && had_any {
            plan.withdraw.push(SUMMARY_ID.into());
        }

        let badge_changed = self.badge != plan.badge;
        self.badge = plan.badge.clone();
        let quiet = !badge_changed
            && plan.banners.is_empty()
            && !plan.bounce
            && !plan.cancel_bounce
            && plan.withdraw.is_empty();
        (!quiet).then_some(plan)
    }
}

fn banner_id(session_id: &str) -> String {
    format!("{ID_PREFIX}{session_id}")
}

fn banners(fresh: &[&NeedsYouRow], total: usize) -> Vec<Banner> {
    if fresh.len() > MAX_BANNERS {
        return vec![Banner {
            id: SUMMARY_ID.into(),
            title: format!("{total} sessions need you"),
            body: "Open Hoku to see what’s waiting.".into(),
        }];
    }
    fresh.iter().map(|r| banner(r)).collect()
}

/// A banner can show on the lock screen, so it names only the project, the provider and the
/// kind of request. Never the session title, prompt, runtime detail, path or account.
pub fn banner(r: &NeedsYouRow) -> Banner {
    let title = r
        .project
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| text::truncate(p, 64))
        .unwrap_or_else(|| "A session needs you".into());
    let provider = provider_label(r.provider);
    let body = match r.state {
        RuntimeState::Error => format!("{provider} stopped · {}", generic_reason(r)),
        _ => format!("{provider} · {}", generic_reason(r)),
    };
    Banner {
        id: banner_id(&r.session_id),
        title,
        body,
    }
}

fn provider_label(p: Provider) -> &'static str {
    match p {
        Provider::ClaudeCode => "Claude Code",
        Provider::Claude => "Claude",
        Provider::Codex => "Codex",
    }
}

/// The adapters' fixed reason phrases (providers/*.rs) pass through. Anything else, or none,
/// gets a generic phrase, so a banner can never carry provider text verbatim.
fn generic_reason(r: &NeedsYouRow) -> &'static str {
    const WAITING: [&str; 11] = [
        "Waiting for permission",
        "Waiting for approval",
        "Permission requested",
        "Asked a question",
        "Plan needs approval",
        "Needs input",
        "Needs confirmation",
        "Sandbox access requested",
        "A worker needs approval",
        "Proposed a goal",
        "Waiting for you",
    ];
    const BLOCKING_ERRORS: [&str; 2] = ["Authentication required", "Billing needs attention"];
    let reason = r.reason.as_deref().unwrap_or("");
    match r.state {
        RuntimeState::Error => BLOCKING_ERRORS
            .into_iter()
            .find(|p| *p == reason)
            .unwrap_or("Needs your attention"),
        _ => WAITING
            .into_iter()
            .find(|p| *p == reason)
            .unwrap_or("Waiting for you"),
    }
}

// ───────────────────────────── clicks ─────────────────────────────

/// Where a clicked banner leads. `sessionId: null` means the Needs You inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub session_id: Option<String>,
}

/// Parse a banner id back into a destination. Ids Hoku didn't post are ignored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn target_for(identifier: &str) -> Option<Target> {
    let rest = identifier.strip_prefix(ID_PREFIX)?;
    let valid = !rest.is_empty()
        && rest.len() <= 80
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    Some(Target {
        session_id: (valid && rest != "summary").then(|| rest.to_string()),
    })
}

/// The last clicked banner, until the UI picks it up. It survives a cold start: when a click
/// launches Hoku, the webview asks for it once it has loaded.
static PENDING: Mutex<Option<Target>> = Mutex::new(None);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn take_target() -> Option<Target> {
    PENDING.lock().ok()?.take()
}

/// A banner was clicked: bring the window forward (only now, on the user's click) and tell the
/// UI to go to the session. Nothing is opened in the provider until the user chooses to.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clicked(identifier: &str) {
    use tauri::{Emitter, Manager};
    let Some(target) = target_for(identifier) else {
        return;
    };
    if let Ok(mut p) = PENDING.lock() {
        *p = Some(target);
    }
    let Some(app) = APP.get() else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    });
    let _ = app.emit("hub://notification", ());
}

// ───────────────────────────── wiring ─────────────────────────────

/// Set up click handling. Call once from `setup`, on the main thread, as early as possible so a
/// click that launched Hoku is still delivered.
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    native::install();
}

/// One pass: read who needs you, diff, and apply the result on the main thread. Never blocks
/// the main thread, and never holds a lock while waiting on it.
pub fn reconcile(app: &tauri::AppHandle, db: &Mutex<Connection>, tracker: &Mutex<Tracker>) {
    let (rows, prefs) = {
        let Ok(c) = db.lock() else {
            return;
        };
        let Ok(rows) = db::needs_you_sessions(&c) else {
            return;
        };
        (
            rows,
            Prefs::from_settings(&db::get_settings(&c).unwrap_or_default()),
        )
    };
    let foreground = in_front(app);
    let plan = match tracker.lock() {
        Ok(mut t) => t.step(&rows, prefs, foreground, Instant::now()),
        Err(_) => return,
    };
    if let Some(plan) = plan {
        let _ = app.run_on_main_thread(move || native::apply(&plan));
    }
}

/// The window is up front and focused: the user is looking at Hoku, so no banner or bounce.
fn in_front(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.get_webview_window("main")
        .map(|w| {
            w.is_focused().unwrap_or(false)
                && w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(true)
        })
        .unwrap_or(false)
}

/// What macOS allows Hoku to show, for Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationStatus {
    /// "authorized" | "provisional" | "denied" | "not-determined" | "unavailable".
    pub permission: &'static str,
    /// Banners/alerts are on for Hoku in System Settings.
    pub alerts: bool,
    /// "Badge application icon" is on for Hoku in System Settings.
    pub badges: bool,
    /// Dock badge and bounce exist on this operating system.
    pub dock: bool,
}

impl NotificationStatus {
    const UNAVAILABLE: Self = NotificationStatus {
        permission: "unavailable",
        alerts: false,
        badges: false,
        dock: false,
    };
}

/// Blocking: waits for UserNotifications' answer. Call off the main thread.
pub fn status() -> NotificationStatus {
    native::status()
}

/// Ask macOS for permission (it prompts only the first time), then report the result.
/// Blocking while the prompt is up. Call off the main thread.
pub fn request_permission() -> NotificationStatus {
    native::request();
    native::status()
}

#[cfg(target_os = "macos")]
mod native {
    use super::{clicked, NotificationStatus, Plan, ID_PREFIX};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_app_kit::{NSApplication, NSRequestUserAttentionType};
    use objc2_foundation::{
        ns_string, MainThreadMarker, NSArray, NSBundle, NSError, NSObject, NSString,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSetting,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;

    thread_local! {
        /// The pending Dock attention request (main thread only).
        static BOUNCE: Cell<Option<isize>> = const { Cell::new(None) };
    }

    /// UserNotifications needs an app bundle. An unbundled binary (`pnpm tauri dev`) would
    /// raise an Objective-C exception, so banners are simply unavailable there. The Dock badge
    /// and bounce are plain AppKit and work either way.
    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        static BUNDLED: OnceLock<bool> = OnceLock::new();
        let bundled = *BUNDLED.get_or_init(|| {
            let b = NSBundle::mainBundle();
            b.bundleIdentifier().is_some() && b.bundlePath().to_string().ends_with(".app")
        });
        bundled.then(UNUserNotificationCenter::currentNotificationCenter)
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and Delegate doesn't implement Drop.
        // Not main-thread-only: UserNotifications may call it on a background queue.
        #[unsafe(super(NSObject))]
        #[name = "HokuNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// Hoku only posts while its window isn't in front; if it came forward since, the
            /// banner still shows once rather than being lost.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                done.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                done: &block2::DynBlock<dyn Fn()>,
            ) {
                // SAFETY: a static NSString constant exported by UserNotifications.
                let default = unsafe { UNNotificationDefaultActionIdentifier };
                if response.actionIdentifier().isEqualToString(default) {
                    clicked(&response.notification().request().identifier().to_string());
                }
                done.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn install() {
        let Some(center) = center() else {
            return;
        };
        let delegate = Delegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; this one lives as long as Hoku.
        std::mem::forget(delegate);
    }

    /// Main thread only (called through `run_on_main_thread`).
    pub fn apply(plan: &Plan) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let label = plan.badge.as_deref().map(NSString::from_str);
        app.dockTile().setBadgeLabel(label.as_deref());
        if plan.cancel_bounce {
            if let Some(id) = BOUNCE.with(Cell::take) {
                app.cancelUserAttentionRequest(id);
            }
        }
        // Informational: one bounce, never the repeating critical kind. macOS ignores it while
        // Hoku is active and stops it when Hoku is activated.
        if plan.bounce && !app.isActive() {
            let id = app.requestUserAttention(NSRequestUserAttentionType::InformationalRequest);
            BOUNCE.with(|b| b.set(Some(id)));
        }

        let Some(center) = center() else {
            return;
        };
        if !plan.withdraw.is_empty() {
            center.removeDeliveredNotificationsWithIdentifiers(&ids(&plan.withdraw));
        }
        if let Some(keep) = plan.keep_only.clone() {
            withdraw_all_but(&center, keep);
        }
        for b in &plan.banners {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&b.title));
            content.setBody(&NSString::from_str(&b.body));
            content.setThreadIdentifier(ns_string!("needs-you"));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&b.id),
                &content,
                None,
            );
            center.addNotificationRequest_withCompletionHandler(&request, None);
        }
    }

    fn ids(ids: &[String]) -> Retained<NSArray<NSString>> {
        let v: Vec<Retained<NSString>> = ids.iter().map(|s| NSString::from_str(s)).collect();
        NSArray::from_retained_slice(&v)
    }

    fn withdraw_all_but(center: &UNUserNotificationCenter, keep: Vec<String>) {
        let block = RcBlock::new(move |delivered: NonNull<NSArray<UNNotification>>| {
            // SAFETY: UserNotifications passes a valid array for the duration of the call.
            let delivered = unsafe { delivered.as_ref() };
            let stale: Vec<String> = delivered
                .iter()
                .map(|n| n.request().identifier().to_string())
                .filter(|id| id.starts_with(ID_PREFIX) && !keep.contains(id))
                .collect();
            if !stale.is_empty() {
                UNUserNotificationCenter::currentNotificationCenter()
                    .removeDeliveredNotificationsWithIdentifiers(&ids(&stale));
            }
        });
        center.getDeliveredNotificationsWithCompletionHandler(&block);
    }

    pub fn status() -> NotificationStatus {
        let Some(center) = center() else {
            return NotificationStatus::UNAVAILABLE;
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
            // SAFETY: valid for the duration of the call.
            let s = unsafe { s.as_ref() };
            let _ = tx.send((s.authorizationStatus(), s.alertSetting(), s.badgeSetting()));
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
        let Ok((auth, alerts, badges)) = rx.recv_timeout(Duration::from_secs(3)) else {
            return NotificationStatus::UNAVAILABLE;
        };
        NotificationStatus {
            permission: match auth {
                UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Ephemeral => {
                    "authorized"
                }
                UNAuthorizationStatus::Provisional => "provisional",
                UNAuthorizationStatus::Denied => "denied",
                _ => "not-determined",
            },
            alerts: alerts == UNNotificationSetting::Enabled,
            badges: badges == UNNotificationSetting::Enabled,
            dock: true,
        }
    }

    pub fn request() {
        let Some(center) = center() else {
            return;
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
            let _ = tx.send(());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge,
            &block,
        );
        // The prompt waits for the user; give up on waiting (not on the request) after a while.
        let _ = rx.recv_timeout(Duration::from_secs(300));
    }
}

#[cfg(target_os = "linux")]
mod native {
    use super::{NotificationStatus, Plan};
    use std::process::{Command, Stdio};

    pub fn install() {}

    pub fn apply(plan: &Plan) {
        let Some(bin) = notify_send() else {
            return;
        };
        for banner in &plan.banners {
            // notify-send has no delivered-notification id Hoku can withdraw later,
            // and no click action that opens the session.
            let _ = Command::new(&bin)
                .args(banner_args(&banner.title, &banner.body))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }

    pub fn status() -> NotificationStatus {
        status_when(notify_send().is_some())
    }

    pub fn request() {}

    fn status_when(notify_send_installed: bool) -> NotificationStatus {
        if notify_send_installed {
            NotificationStatus {
                permission: "authorized",
                alerts: true,
                badges: false,
                dock: false,
            }
        } else {
            NotificationStatus::UNAVAILABLE
        }
    }

    /// `--app-name` only. No hint, action, or URL: a click cannot open a session.
    fn banner_args(title: &str, body: &str) -> Vec<String> {
        vec!["--app-name=Hoku".into(), title.into(), body.into()]
    }

    fn notify_send() -> Option<std::path::PathBuf> {
        let mut dirs = Vec::new();
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        dirs.push(std::path::PathBuf::from("/usr/bin"));
        find_notify_send(dirs)
    }

    fn find_notify_send(
        dirs: impl IntoIterator<Item = std::path::PathBuf>,
    ) -> Option<std::path::PathBuf> {
        dirs.into_iter()
            .map(|d| d.join("notify-send"))
            .find(|p| p.is_file())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn missing_notify_send_reports_unavailable_and_no_dock() {
            let status = status_when(false);
            assert_eq!(status, NotificationStatus::UNAVAILABLE);
            assert!(!status.dock);
            assert!(!status.alerts);
            assert!(!status.badges);
        }

        #[test]
        fn installed_notify_send_alerts_without_a_badge_or_dock() {
            let status = status_when(true);
            assert_eq!(status.permission, "authorized");
            assert!(status.alerts);
            assert!(!status.badges);
            assert!(!status.dock);
        }

        #[test]
        fn banner_is_a_title_and_body_with_no_click_target() {
            let args = banner_args("Checkout needs you", "Waiting for permission");
            assert_eq!(
                args,
                vec![
                    "--app-name=Hoku",
                    "Checkout needs you",
                    "Waiting for permission",
                ]
            );
            assert_eq!(args.len(), 3, "title and body stay single arguments");
        }

        #[test]
        fn lookup_finds_notify_send_only_as_a_file_in_the_given_dirs() {
            let tmp = tempfile::tempdir().unwrap();
            let empty = tmp.path().join("empty");
            std::fs::create_dir(&empty).unwrap();
            assert!(find_notify_send([empty.clone()]).is_none());
            let bin = tmp.path().join("notify-send");
            std::fs::write(&bin, b"").unwrap();
            assert_eq!(
                find_notify_send([empty, tmp.path().to_path_buf()]).unwrap(),
                bin
            );
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod native {
    use super::{NotificationStatus, Plan};
    pub fn install() {}
    pub fn apply(_: &Plan) {}
    pub fn status() -> NotificationStatus {
        NotificationStatus::UNAVAILABLE
    }
    pub fn request() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: Prefs = Prefs {
        banners: true,
        badge: true,
        bounce: false,
    };

    fn row(id: &str, state: RuntimeState, reason: Option<&str>) -> NeedsYouRow {
        NeedsYouRow {
            session_id: id.into(),
            provider: Provider::ClaudeCode,
            project: Some("Checkout".into()),
            state,
            reason: reason.map(Into::into),
            demo: false,
        }
    }

    fn waiting(id: &str) -> NeedsYouRow {
        row(id, RuntimeState::NeedsInput, Some("Waiting for permission"))
    }

    /// A tracker that has already seen launch (nothing waiting).
    fn primed(at: Instant) -> Tracker {
        let mut t = Tracker::default();
        t.step(&[], ON, false, at);
        t
    }

    #[test]
    fn launch_shows_the_count_but_replays_nothing() {
        let mut t = Tracker::default();
        let now = Instant::now();
        let plan = t
            .step(&[waiting("a"), waiting("b")], ON, false, now)
            .unwrap();
        assert_eq!(plan.badge.as_deref(), Some("2"));
        assert!(plan.banners.is_empty(), "no backlog on startup");
        assert!(!plan.bounce);
        assert_eq!(
            plan.keep_only,
            Some(vec![
                "needs-you:a".to_string(),
                "needs-you:b".into(),
                "needs-you:summary".into()
            ])
        );
        // Still waiting on the next pass: nothing to do.
        assert_eq!(t.step(&[waiting("a"), waiting("b")], ON, false, now), None);
    }

    #[test]
    fn a_new_episode_alerts_once() {
        let now = Instant::now();
        let mut t = primed(now);
        let plan = t.step(&[waiting("a")], ON, false, now).unwrap();
        assert_eq!(plan.badge.as_deref(), Some("1"));
        assert_eq!(
            plan.banners,
            vec![Banner {
                id: "needs-you:a".into(),
                title: "Checkout".into(),
                body: "Claude Code · Waiting for permission".into(),
            }]
        );
        // Re-observed every tick, even with a different reason: same episode, no repeat.
        for i in 1..5 {
            let r = row("a", RuntimeState::NeedsInput, Some("Asked a question"));
            assert_eq!(
                t.step(&[r], ON, false, now + TICK * i),
                None,
                "tick {i} is quiet"
            );
        }
    }

    const TICK: Duration = Duration::from_secs(4);

    #[test]
    fn resolving_clears_the_badge_and_withdraws_the_banner() {
        let now = Instant::now();
        let mut t = primed(now);
        t.step(&[waiting("a"), waiting("b")], ON, false, now);
        let plan = t.step(&[waiting("b")], ON, false, now + TICK).unwrap();
        assert_eq!(plan.badge.as_deref(), Some("1"));
        assert_eq!(plan.withdraw, vec!["needs-you:a".to_string()]);
        assert!(plan.banners.is_empty());
        let plan = t.step(&[], ON, false, now + TICK * 2).unwrap();
        assert_eq!(plan.badge, None);
        assert_eq!(
            plan.withdraw,
            vec!["needs-you:b".to_string(), "needs-you:summary".into()]
        );
    }

    #[test]
    fn flapping_back_quickly_stays_quiet_but_a_later_episode_alerts() {
        let now = Instant::now();
        let mut t = primed(now);
        assert_eq!(
            t.step(&[waiting("a")], ON, false, now)
                .unwrap()
                .banners
                .len(),
            1
        );
        t.step(&[], ON, false, now + TICK);
        let back = t.step(&[waiting("a")], ON, false, now + TICK * 2).unwrap();
        assert!(back.banners.is_empty(), "re-entry within the quiet window");
        assert_eq!(
            back.badge.as_deref(),
            Some("1"),
            "the badge still counts it"
        );

        t.step(&[], ON, false, now + TICK * 3);
        let later = now + TICK * 3 + REENTRY_QUIET + TICK;
        let again = t.step(&[waiting("a")], ON, false, later).unwrap();
        assert_eq!(again.banners.len(), 1, "a real new request after a while");
    }

    #[test]
    fn several_sessions_each_alert_and_a_burst_is_summarised() {
        let now = Instant::now();
        let mut t = primed(now);
        let plan = t
            .step(&[waiting("a"), waiting("b")], ON, false, now)
            .unwrap();
        assert_eq!(plan.banners.len(), 2);
        // A third arrives later: only it alerts.
        let plan = t
            .step(
                &[waiting("a"), waiting("b"), waiting("c")],
                ON,
                false,
                now + TICK,
            )
            .unwrap();
        assert_eq!(
            plan.banners
                .iter()
                .map(|b| b.id.as_str())
                .collect::<Vec<_>>(),
            vec!["needs-you:c"]
        );

        let mut t = primed(now);
        let burst: Vec<NeedsYouRow> = ["a", "b", "c", "d", "e"].map(waiting).into();
        let plan = t.step(&burst, ON, false, now).unwrap();
        assert_eq!(plan.banners.len(), 1);
        assert_eq!(plan.banners[0].id, "needs-you:summary");
        assert_eq!(plan.banners[0].title, "5 sessions need you");
        assert_eq!(plan.badge.as_deref(), Some("5"));
    }

    #[test]
    fn no_banner_or_bounce_while_hoku_is_in_front() {
        let now = Instant::now();
        let prefs = Prefs { bounce: true, ..ON };
        let mut t = primed(now);
        let plan = t.step(&[waiting("a")], prefs, true, now).unwrap();
        assert!(plan.banners.is_empty());
        assert!(!plan.bounce);
        assert_eq!(plan.badge.as_deref(), Some("1"));
        // Going to the background later doesn't replay it.
        assert_eq!(t.step(&[waiting("a")], prefs, false, now + TICK), None);
    }

    #[test]
    fn bounce_is_opt_in_once_and_cancelled_when_resolved_or_seen() {
        let now = Instant::now();
        let mut t = primed(now);
        assert!(
            !t.step(&[waiting("a")], ON, false, now).unwrap().bounce,
            "off by default"
        );

        let prefs = Prefs { bounce: true, ..ON };
        let mut t = primed(now);
        assert!(t.step(&[waiting("a")], prefs, false, now).unwrap().bounce);
        assert_eq!(
            t.step(&[waiting("a")], prefs, false, now + TICK),
            None,
            "not every tick"
        );
        let plan = t.step(&[], prefs, false, now + TICK * 2).unwrap();
        assert!(plan.cancel_bounce && !plan.bounce);

        let mut t = primed(now);
        t.step(&[waiting("a")], prefs, false, now);
        let plan = t.step(&[waiting("a")], prefs, true, now + TICK).unwrap();
        assert!(plan.cancel_bounce, "Hoku came forward");
        assert_eq!(t.step(&[waiting("a")], prefs, true, now + TICK * 2), None);
    }

    #[test]
    fn preferences_gate_banners_and_badge() {
        let now = Instant::now();
        let mut t = primed(now);
        let off = Prefs {
            banners: false,
            badge: false,
            bounce: false,
        };
        // Badge off and nothing shown before: nothing to change.
        assert_eq!(t.step(&[waiting("a")], off, false, now), None);
        // Turning the badge on shows the count right away.
        let plan = t
            .step(
                &[waiting("a")],
                Prefs { badge: true, ..off },
                false,
                now + TICK,
            )
            .unwrap();
        assert_eq!(plan.badge.as_deref(), Some("1"));
        assert!(plan.banners.is_empty());
        // And off again clears it.
        let plan = t.step(&[waiting("a")], off, false, now + TICK * 2).unwrap();
        assert_eq!(plan.badge, None);
    }

    #[test]
    fn defaults_are_badge_on_banners_and_bounce_off() {
        let p = Prefs::from_settings(&Map::new());
        assert_eq!(
            p,
            Prefs {
                banners: false,
                badge: true,
                bounce: false
            }
        );
        let mut m = Map::new();
        m.insert(BANNERS_KEY.into(), Value::Bool(true));
        m.insert(BADGE_KEY.into(), Value::Bool(false));
        m.insert(BOUNCE_KEY.into(), Value::Bool(true));
        assert_eq!(
            Prefs::from_settings(&m),
            Prefs {
                banners: true,
                badge: false,
                bounce: true
            }
        );
    }

    #[test]
    fn demo_sessions_count_but_never_alert() {
        let now = Instant::now();
        let mut t = primed(now);
        let demo = NeedsYouRow {
            demo: true,
            ..waiting("d")
        };
        let plan = t
            .step(&[demo], Prefs { bounce: true, ..ON }, false, now)
            .unwrap();
        assert_eq!(plan.badge.as_deref(), Some("1"));
        assert!(plan.banners.is_empty() && !plan.bounce);
    }

    #[test]
    fn banners_never_carry_provider_text() {
        let odd = row(
            "a",
            RuntimeState::NeedsInput,
            Some("rm -rf ~/secret-project"),
        );
        assert_eq!(banner(&odd).body, "Claude Code · Waiting for you");
        let none = row("a", RuntimeState::NeedsInput, None);
        assert_eq!(banner(&none).body, "Claude Code · Waiting for you");

        let auth = NeedsYouRow {
            provider: Provider::Codex,
            ..row("a", RuntimeState::Error, Some("Authentication required"))
        };
        assert_eq!(
            banner(&auth).body,
            "Codex stopped · Authentication required"
        );
        let other = row("a", RuntimeState::Error, Some("Stack trace: /Users/me/x"));
        assert_eq!(
            banner(&other).body,
            "Claude Code stopped · Needs your attention"
        );

        let unsorted = NeedsYouRow {
            project: None,
            ..waiting("a")
        };
        assert_eq!(banner(&unsorted).title, "A session needs you");
        let long = NeedsYouRow {
            project: Some("x".repeat(200)),
            ..waiting("a")
        };
        assert!(banner(&long).title.chars().count() <= 64);
    }

    #[test]
    fn click_targets_parse_only_hoku_banners() {
        assert_eq!(
            target_for("needs-you:3f2a9c1e-0000-4000-8000-000000000001"),
            Some(Target {
                session_id: Some("3f2a9c1e-0000-4000-8000-000000000001".into())
            })
        );
        assert_eq!(
            target_for("needs-you:summary"),
            Some(Target { session_id: None })
        );
        // Malformed ids fall back to the inbox rather than reaching the UI.
        assert_eq!(
            target_for("needs-you:../../etc"),
            Some(Target { session_id: None })
        );
        assert_eq!(target_for("something-else"), None);
    }

    #[test]
    fn the_needs_you_query_matches_the_ui_rule() {
        use crate::db::{open_in_memory, upsert_discovered};
        use crate::models::{Confidence, DiscoveredSession, RuntimeStatus};
        let c = open_in_memory();
        let p = db::create_project(
            &c,
            db::ProjectInput {
                name: "Checkout".into(),
                root_path: None,
                icon: None,
                color: None,
                is_demo: false,
            },
        )
        .unwrap();
        let mut ids = vec![];
        for (ext, state, action) in [
            ("w1", RuntimeState::NeedsInput, true),
            ("e1", RuntimeState::Error, true),
            ("e2", RuntimeState::Error, false),
            ("r1", RuntimeState::Ready, false),
            ("k1", RuntimeState::Working, false),
        ] {
            let d = DiscoveredSession {
                external_id: ext.into(),
                title: "Private title".into(),
                ..Default::default()
            };
            upsert_discovered(&c, Provider::Codex, "fake", &d, None, None).unwrap();
            let s = db::find_session_by_external(&c, Provider::Codex, ext)
                .unwrap()
                .unwrap()
                .id;
            db::write_runtime(
                &c,
                &s,
                &RuntimeStatus {
                    state,
                    confidence: Confidence::High,
                    reason: Some("Waiting for approval".into()),
                    detail: Some("Allow pushing to origin?".into()),
                    source: Some("fake".into()),
                    action_required: action,
                    since: None,
                    last_observed_at: None,
                },
            )
            .unwrap();
            ids.push(s);
        }
        c.execute(
            "UPDATE sessions SET project_id = ?1 WHERE id = ?2",
            rusqlite::params![p.id, ids[0]],
        )
        .unwrap();
        let mut rows = db::needs_you_sessions(&c).unwrap();
        rows.sort_by_key(|r| r.state.as_str());
        assert_eq!(rows.len(), 2, "needs_input and the blocking error only");
        assert_eq!(rows[0].state, RuntimeState::Error);
        assert_eq!(rows[1].state, RuntimeState::NeedsInput);
        assert_eq!(rows[1].project.as_deref(), Some("Checkout"));
        assert_eq!(rows[0].project, None);
    }
}
