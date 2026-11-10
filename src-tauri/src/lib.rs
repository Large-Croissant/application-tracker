mod commands;
mod db;
mod models;

use commands::{
    add_correspondence, add_event, add_prepared_answer, add_reference, add_resume,
    create_application, delete_application, delete_correspondence, delete_event,
    delete_prepared_answer, delete_reference, delete_resume, delete_sample_data, list_all_events,
    list_applications, list_correspondence, list_events, list_prepared_answers, list_profile,
    list_references, list_resumes, seed_sample_data, set_profile, update_application,
    update_correspondence, update_event, update_prepared_answer, update_reference, update_resume,
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
            list_all_events,
            seed_sample_data,
            delete_sample_data,
            add_event,
            update_event,
            delete_event,
            list_correspondence,
            add_correspondence,
            update_correspondence,
            delete_correspondence,
            list_profile,
            set_profile,
            list_references,
            add_reference,
            update_reference,
            delete_reference,
            list_prepared_answers,
            add_prepared_answer,
            update_prepared_answer,
            delete_prepared_answer,
            list_resumes,
            add_resume,
            update_resume,
            delete_resume,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
