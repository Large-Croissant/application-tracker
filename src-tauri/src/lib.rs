mod backup;
mod commands;
mod db;
mod models;
mod sync;

use backup::{
    backup_get_days, backup_list, backup_now, backup_set_days, export_csv, reveal_backup_folder,
};
use commands::{
    add_correspondence, add_event, add_prepared_answer, add_reference, add_resume,
    create_application, delete_application, delete_applications, delete_correspondence,
    delete_event,
    delete_prepared_answer, delete_reference, delete_resume, delete_sample_data,
    delete_imported_flosa, import_applications, list_all_events, list_applications,
    list_correspondence, list_events, list_prepared_answers, list_profile, list_references,
    list_resumes, reorder_profile, seed_sample_data, set_profile, update_application,
    update_correspondence, update_event, update_prepared_answer, update_reference, update_resume,
};
use db::DbState;
use sync::{
    sync_check_cloud, sync_complete_connect, sync_cycle, sync_disconnect, sync_get_info,
    sync_pull, sync_push, sync_save_settings, sync_start_connect, SyncState,
};
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::open_db(&app_data_dir)
                .expect("failed to open the JobTracker database");
            app.manage(DbState(std::sync::Mutex::new(conn)));
            app.manage(SyncState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_applications,
            create_application,
            update_application,
            delete_application,
            delete_applications,
            list_events,
            list_all_events,
            seed_sample_data,
            delete_sample_data,
            import_applications,
            delete_imported_flosa,
            reorder_profile,
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
            sync_get_info,
            sync_save_settings,
            sync_start_connect,
            sync_complete_connect,
            sync_disconnect,
            sync_push,
            sync_pull,
            sync_cycle,
            sync_check_cloud,
            backup_now,
            backup_list,
            backup_get_days,
            backup_set_days,
            reveal_backup_folder,
            export_csv,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Local backup first (instant, works offline), then upload.
                backup::auto_backup_on_exit(app);
                sync::auto_push_on_exit(app);
            }
        });
}
