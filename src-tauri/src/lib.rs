mod association;
mod commands;
mod db;
mod demo;
#[cfg(debug_assertions)]
mod devtools;
mod integrations;
mod launch;
mod models;
mod providers;
mod recap;
mod resume;
mod runtime;
mod scan;

use commands::AppState;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|app| {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        if let Some(from) = db::adopt_legacy_index(&dir) {
            eprintln!("[hoku] carried the index over from {}", from.display());
        }
        let conn = db::open(&dir.join("hub.sqlite"))?;
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            adapters: Arc::new(commands::default_adapters()),
            monitor: Arc::new(Mutex::new(runtime::MonitorState::default())),
            claude_home: std::path::PathBuf::from(association::home_dir()).join(".claude"),
            draft: Arc::new(Mutex::new(None)),
        };
        runtime::start(
            app.handle().clone(),
            state.db.clone(),
            state.adapters.clone(),
            state.monitor.clone(),
        );
        app.manage(state);
        #[cfg(debug_assertions)]
        devtools::start(app.handle().clone());
        Ok(())
    });

    macro_rules! handlers {
        ($($extra:path),*) => {
            tauri::generate_handler![
                commands::get_snapshot,
                commands::create_project,
                commands::update_project,
                commands::delete_project,
                commands::archive_project,
                commands::update_project_resume,
                commands::ai_draft_status,
                commands::prepare_resume_draft,
                commands::generate_resume_draft,
                commands::create_projects_from_suggestions,
                commands::project_suggestions,
                commands::parse_reference,
                commands::add_manual_session,
                commands::update_session,
                commands::delete_session,
                commands::set_link,
                commands::open_session,
                commands::copy_text,
                commands::spaces_switch_enabled,
                commands::open_spaces_settings,
                commands::reveal_path,
                commands::open_provider_app,
                commands::get_recap,
                commands::create_outcome,
                commands::update_outcome,
                commands::delete_outcome,
                commands::save_recap_image,
                commands::copy_recap_image,
                commands::scan_sessions,
                commands::refresh_runtime,
                commands::integration_status,
                commands::create_account,
                commands::rename_account,
                commands::set_setting,
                commands::load_demo,
                commands::clear_demo,
                commands::database_path
                $(, $extra)*
            ]
        };
    }

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(handlers!(devtools::dev_report));
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(handlers!());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Hoku");
}
