//! Debug builds only: a localhost control socket so the UI can be driven and visually
//! inspected during development (WKWebView snapshots need no Screen Recording permission).
//! Compiled out of release builds entirely.
//!
//! Protocol: one JSON object per connection, e.g.
//!   {"cmd":"eval","js":"document.title"}         → evaluates JS, replies "ok"
//!   {"cmd":"snapshot","path":"/tmp/x.png"}       → writes a PNG of the webview
//!   {"cmd":"report"}                              → last value sent via `dev_report`

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Manager};

pub const PORT: u16 = 47831;

static LAST_REPORT: Mutex<String> = Mutex::new(String::new());

#[tauri::command]
pub fn dev_report(value: String) {
    *LAST_REPORT.lock().unwrap() = value;
}

pub fn start(app: AppHandle) {
    keep_rendering_when_occluded(&app);
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)) else {
            eprintln!("[devtools] port {PORT} busy; control socket disabled");
            return;
        };
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let reply = handle(&app, &line).unwrap_or_else(|e| format!("error: {e}"));
            let mut s = stream;
            let _ = s.write_all(reply.as_bytes());
        }
    });
}

/// WebKit pauses painting for occluded windows, which makes snapshots stale while the app
/// sits behind other windows. Debug builds opt out (private WebKit SPI, never in release).
#[cfg(target_os = "macos")]
fn keep_rendering_when_occluded(app: &AppHandle) {
    use objc2::runtime::{AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(|wv| unsafe {
            let webview = wv.inner() as *mut AnyObject;
            let selector: Sel = sel!(_setWindowOcclusionDetectionEnabled:);
            let responds: Bool = msg_send![&*webview, respondsToSelector: selector];
            if responds.as_bool() {
                let _: () = msg_send![&*webview, _setWindowOcclusionDetectionEnabled: Bool::NO];
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
fn keep_rendering_when_occluded(_: &AppHandle) {}

fn handle(app: &AppHandle, line: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let window = app.get_webview_window("main").ok_or("no main window")?;
    match v.get("cmd").and_then(|c| c.as_str()) {
        Some("eval") => {
            let js = v.get("js").and_then(|j| j.as_str()).ok_or("missing js")?;
            window.eval(js).map_err(|e| e.to_string())?;
            Ok("ok".into())
        }
        Some("report") => Ok(LAST_REPORT.lock().unwrap().clone()),
        Some("snapshot") => {
            let path = v
                .get("path")
                .and_then(|p| p.as_str())
                .ok_or("missing path")?
                .to_string();
            snapshot(&window, path)
        }
        _ => Err("unknown cmd".into()),
    }
}

#[cfg(target_os = "macos")]
fn snapshot(window: &tauri::WebviewWindow, path: String) -> Result<String, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    window
        .with_webview(move |wv| unsafe {
            let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
            let tx = tx.clone();
            let path = path.clone();
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                if image.is_null() {
                    let msg = if error.is_null() {
                        "no image".to_string()
                    } else {
                        (*error).localizedDescription().to_string()
                    };
                    let _ = tx.send(Err(msg));
                    return;
                }
                let image = &*image;
                let result = (|| {
                    let tiff = image.TIFFRepresentation().ok_or("no tiff")?;
                    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("no bitmap")?;
                    let png = rep
                        .representationUsingType_properties(
                            NSBitmapImageFileType::PNG,
                            &NSDictionary::new(),
                        )
                        .ok_or("no png")?;
                    std::fs::write(&path, png.to_vec()).map_err(|e| e.to_string())?;
                    Ok::<_, String>(path.clone())
                })();
                let _ = tx.send(result.map_err(|e: String| e));
            });
            webview.takeSnapshotWithConfiguration_completionHandler(None, &block);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_: &tauri::WebviewWindow, _: String) -> Result<String, String> {
    Err("snapshots are macOS-only".into())
}
