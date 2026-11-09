mod commands;
mod db;
mod models;

use commands::{create_application, delete_application, list_applications, update_application};
use db::DbState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
