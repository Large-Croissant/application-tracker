mod commands;
mod db;
mod models;

use commands::{
    add_correspondence, add_event, create_application, delete_application, delete_correspondence,
    delete_event, list_applications, list_correspondence, list_events, update_application,
    update_correspondence, update_event,
};
use db::DbState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::open_db(&app_data_dir)
                .expect("failed to open the JobTracker database");
            app.manage(DbState(std::sync::Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_applications,
            create_application,
            update_application,
            delete_application,
            list_events,
            add_event,
            update_event,
            delete_event,
            list_correspondence,
            add_correspondence,
            update_correspondence,
            delete_correspondence,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
