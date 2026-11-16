//! Local backups and CSV export.
//!
//! Backups are full, self-contained SQLite files written with `VACUUM INTO`
//! (always consistent regardless of WAL state), one per close with a date+time
//! name. Retention keeps the newest N local *days* (configurable, default 14).
//! They run automatically when the app closes and can be triggered manually
//! from Settings. CSV export goes through a native save dialog.

use chrono::{Local, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db::DbState;

fn backups_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve the app data directory: {e}"))?
        .join("backups");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create the backups directory: {e}"))?;
    Ok(dir)
}

fn lock_db<'a>(
    db: &'a tauri::State<'_, DbState>,
) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    db.0.lock().map_err(|_| "Database is busy".to_string())
}

/// How many days of backup files to keep, from the sync config (Settings
/// → Backups & export). Defaults to 14 when unset.
pub fn retention_days(app: &tauri::AppHandle) -> u32 {
    crate::sync::load_config(app)
        .map(|c| c.backup_days)
        .unwrap_or(14)
}

/// Writes a backup file for this moment (`jobtracker-YYYY-MM-DD-HHMMSS.db`)
/// and prunes old ones (newest N *days* kept, all of each day's copies).
/// Returns the file path.
pub fn create_backup(
    app: &tauri::AppHandle,
    db: &tauri::State<'_, DbState>,
) -> Result<String, String> {
    let dir = backups_dir(app)?;
    let path = dir.join(format!(
        "jobtracker-{}.db",
        Local::now().format("%Y-%m-%d_%H%M%S")
    ));
    // VACUUM INTO refuses to overwrite an existing file.
    let _ = std::fs::remove_file(&path);
    let conn = lock_db(db)?;
    conn.execute("VACUUM INTO ?1", params![path.to_string_lossy().as_ref()])
        .map_err(|e| format!("Backup failed: {e}"))?;
    prune_backups(&dir, retention_days(app))?;
    Ok(path.display().to_string())
}

/// Deletes backups older than the newest `keep_days` distinct local days, so
/// several same-day copies survive without unbounded growth.
fn backup_day(name: &str) -> String {
    // "jobtracker-YYYY-MM-DD…" → "YYYY-MM-DD" (10 chars); legacy
    // "jobtracker-YYYY-MM-DD.db" files extract the same way.
    name["jobtracker-".len()..]
        .chars()
        .take(10)
        .collect::<String>()
}

fn prune_backups(dir: &std::path::Path, keep_days: u32) -> Result<(), String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to list backups: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("jobtracker-") && n.ends_with(".db"))
        .collect();
    if names.is_empty() {
        return Ok(());
    }
    names.sort();
    names.reverse(); // newest first (date, then time)
    // Distinct days, newest first.
    let mut days: Vec<String> = Vec::new();
    for name in &names {
        let day = backup_day(name);
        if days.last().map(|d| d != &day).unwrap_or(true) {
            days.push(day);
        }
    }
    if days.len() <= keep_days as usize {
        return Ok(());
    }
    let keep_until = &days[keep_days as usize - 1]; // oldest day we retain
    for name in names {
        if backup_day(&name) < *keep_until {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    Ok(())
}

/// Metadata about one backup file, for the Settings UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub size_bytes: u64,
    /// UTC ISO timestamp of the file's last modification.
    pub modified: String,
}

#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupEntry>, String> {
    let dir = backups_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Failed to list backups: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to list backups: {e}"))?;
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if !(name.starts_with("jobtracker-") && name.ends_with(".db")) {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .map(|t| {
                let t: chrono::DateTime<Utc> = t.into();
                t.to_rfc3339_opts(SecondsFormat::Secs, true)
            })
            .unwrap_or_default();
        out.push(BackupEntry {
            name,
            size_bytes: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

#[tauri::command]
pub fn backup_now(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
) -> Result<String, String> {
    create_backup(&app, &db)
}

#[tauri::command]
pub fn backup_get_days(app: tauri::AppHandle) -> u32 {
    retention_days(&app)
}

/// Sets how many days of backups to keep. Clamped to 1..=365.
#[tauri::command]
pub fn backup_set_days(app: tauri::AppHandle, days: u32) -> Result<u32, String> {
    let days = days.clamp(1, 365);
    let mut config = crate::sync::load_config(&app)?;
    config.backup_days = days;
    crate::sync::save_config(&app, &config)?;
    Ok(days)
}

#[tauri::command]
pub fn reveal_backup_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = backups_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Could not open the folder: {e}"))
}

/// CSV field quoting per RFC 4180.
fn csv_field(v: &str) -> String {
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

const CSV_COLUMNS: &[&str] = &[
    "id",
    "company",
    "role",
    "status",
    "location",
    "work_mode",
    "source",
    "posting_url",
    "salary_amount",
    "salary_amount_max",
    "salary_currency",
    "salary_period",
    "contact_name",
    "contact_email",
    "notes",
    "applied_at",
    "next_followup_at",
    "created_at",
    "updated_at",
];

/// Exports the applications table to a CSV file chosen in a native save
/// dialog, then reveals it in Explorer. Returns `None` when cancelled.
#[tauri::command]
pub async fn export_csv(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
) -> Result<Option<String>, String> {
    // Build the full CSV while holding the DB lock — before any await.
    let out = build_csv(&db)?;

    // Native save dialog (blocks its own thread, not the UI).
    let default_name = format!(
        "jobtracker-applications-{}.csv",
        Local::now().format("%Y%m%d-%H%M%S")
    );
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("CSV files", &["csv"])
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    // None = the user cancelled; not an error.
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    // Silently add the .csv extension when the user left it off.
    let path = if path.extension().is_none() {
        path.with_extension("csv")
    } else {
        path
    };
    std::fs::write(&path, out).map_err(|e| format!("Failed to write the CSV: {e}"))?;

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("Could not open the file: {e}"))?;
    Ok(Some(path.display().to_string()))
}

/// Renders the applications table to CSV text (RFC 4180, UTF-8 BOM).
fn build_csv(db: &tauri::State<'_, DbState>) -> Result<String, String> {
    let conn = lock_db(db)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM applications ORDER BY updated_at DESC",
            CSV_COLUMNS.join(", ")
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

    // BOM so Excel detects UTF-8 when double-clicked.
    let mut out = String::from("\u{FEFF}");
    out.push_str(&CSV_COLUMNS.join(","));
    out.push_str("\r\n");
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        let text = |i: usize| -> String {
            row.get::<_, Option<String>>(i)
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        let num = |i: usize| -> String {
            row.get::<_, Option<f64>>(i)
                .ok()
                .flatten()
                .map(|v| {
                    if v.fract() == 0.0 {
                        format!("{}", v as i64)
                    } else {
                        format!("{v}")
                    }
                })
                .unwrap_or_default()
        };
        let fields = [
            id.to_string(),
            text(1),
            text(2),
            text(3),
            text(4),
            text(5),
            text(6),
            text(7),
            num(8),
            num(9),
            text(10),
            text(11),
            text(12),
            text(13),
            text(14),
            text(15),
            text(16),
            text(17),
            text(18),
        ];
        out.push_str(
            &fields
                .iter()
                .map(|f| csv_field(f))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    }
    Ok(out)
}

/// Runs on the exit path: one dated backup per day. Best-effort — the result
/// is appended to sync.log; failures never block the app from closing.
pub fn auto_backup_on_exit(app: &tauri::AppHandle) {
    let outcome = tauri::async_runtime::block_on(async {
        let db = app.state::<DbState>();
        create_backup(app, &db)
    });
    let line = match outcome {
        Ok(path) => format!("{} backup OK: {path}", Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        Err(e) => format!(
            "{} backup FAILED: {e}",
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        ),
    };
    if let Ok(dir) = app.path().app_data_dir() {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("sync.log"))
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jobtracker-backup-test-{}-{tag}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A backup file must be a real, independently openable database with
    /// the same data — that's the whole point of a backup.
    #[test]
    fn backup_round_trip() {
        let dir = temp_dir("roundtrip");
        let target = dir.join("jobtracker-test.db");
        let _ = std::fs::remove_file(&target);

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO applications (company, role, status, created_at, updated_at)
             VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();

        conn.execute("VACUUM INTO ?1", params![target.to_string_lossy().as_ref()])
            .unwrap();

        let restored = Connection::open(&target).unwrap();
        let n: i64 = restored
            .query_row("SELECT COUNT(*) FROM applications", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let company: String = restored
            .query_row("SELECT company FROM applications", [], |r| r.get(0))
            .unwrap();
        assert_eq!(company, "Acme");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_newest_days() {
        let dir = temp_dir("prune");
        // Two backups per day across 20 days.
        for i in 1..=20u32 {
            for t in ["090000", "170000"] {
                std::fs::write(
                    dir.join(format!("jobtracker-2026-01-{i:02}_{t}.db")),
                    b"x",
                )
                .unwrap();
            }
        }
        prune_backups(&dir, 14).unwrap();
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        // 14 newest days × 2 files each survive, both copies of those days.
        assert_eq!(left.len(), 28);
        assert!(left.contains(&"jobtracker-2026-01-20_090000.db".to_string()));
        assert!(left.contains(&"jobtracker-2026-01-20_170000.db".to_string()));
        assert!(left.contains(&"jobtracker-2026-01-07_170000.db".to_string()));
        assert!(!left.contains(&"jobtracker-2026-01-06_090000.db".to_string()));
        assert!(!left.contains(&"jobtracker-2026-01-01_170000.db".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_day_extracts_date() {
        assert_eq!(backup_day("jobtracker-2026-11-15_093012.db"), "2026-11-15");
        assert_eq!(backup_day("jobtracker-2026-11-15.db"), "2026-11-15"); // legacy name
    }

    #[test]
    fn csv_fields_escape_correctly() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
    }
}
