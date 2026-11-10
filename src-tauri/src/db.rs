use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection};
use std::path::Path;

/// Organized UTC timestamp, ISO-8601 with millisecond precision.
/// Used for every `created_at` / `updated_at` and drives the sync merge later.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Wrapper for the shared SQLite connection managed by Tauri.
pub struct DbState(pub std::sync::Mutex<Connection>);

/// Opens (or creates) the database inside the app-data directory and runs migrations.
pub fn open_db(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    let conn =
        Connection::open(app_data_dir.join("jobtracker.db")).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    migrate(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Schema for the full app (all pillars), created idempotently.
/// Kept in one place so the synced snapshot always contains the complete dataset.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    // Raw string literal so SQL comments may contain quote characters.
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'wishlist',
            source TEXT NOT NULL DEFAULT '',
            posting_url TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            work_mode TEXT NOT NULL DEFAULT '',
            salary_amount REAL,
            salary_currency TEXT NOT NULL DEFAULT 'USD',
            -- empty = not listed; else: yearly | monthly | hourly | contract | other
            salary_period TEXT NOT NULL DEFAULT '',
            contact_name TEXT NOT NULL DEFAULT '',
            contact_email TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            posting_text TEXT NOT NULL DEFAULT '',
            resume_version_id INTEGER,
            applied_at TEXT,
            next_followup_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Timeline log per application: recruiter call, technical interview, ...
        -- correspondence_id links an entry to its stored correspondence item.
        CREATE TABLE IF NOT EXISTS application_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            -- `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when a time is kept
            occurred_at TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'note',
            note TEXT NOT NULL DEFAULT '',
            correspondence_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_application_events_app
            ON application_events(application_id);

        -- Quick-paste vault: profile fields as key/value pairs (easy to extend)
        CREATE TABLE IF NOT EXISTS profile (
            field_key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

        -- Named reference_contacts (SQLite reserves the word REFERENCES)
        CREATE TABLE IF NOT EXISTS reference_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            relationship TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            company TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            linkedin TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS prepared_answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS resume_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            file_name TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Sync metadata (device id, last pull/push, account info) — phase 4
        CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Correspondence on an application: one record per email, call, or meeting.
        CREATE TABLE IF NOT EXISTS application_correspondence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            -- email | call | meeting
            kind TEXT NOT NULL DEFAULT 'email',
            -- When it happened (or is scheduled): `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`
            occurred_at TEXT NOT NULL,
            -- Meetings only: virtual | in_person
            meeting_mode TEXT,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_application_correspondence_app
            ON application_correspondence(application_id);
        "#,
    )?;
    upgrade_salary_columns(conn)?;
    upgrade_correspondence(conn)?;
    // Copy-paste vault: resume text lives with its version record.
    ensure_column(
        conn,
        "resume_versions",
        "content",
        "TEXT NOT NULL DEFAULT ''",
    )
}

/// One-time upgrade to the correspondence model:
/// - renames the timeline link column `email_id` → `correspondence_id`
/// - migrates the old `application_emails` table into `application_correspondence`
/// - removes the placeholder "Email: ..." note events used before real linking
fn upgrade_correspondence(conn: &Connection) -> rusqlite::Result<()> {
    if column_exists(conn, "application_events", "email_id")?
        && !column_exists(conn, "application_events", "correspondence_id")?
    {
        conn.execute_batch(
            "ALTER TABLE application_events RENAME COLUMN email_id TO correspondence_id;",
        )?;
    }
    if table_exists(conn, "application_emails")? {
        conn.execute_batch(
            "INSERT INTO application_correspondence
                (id, application_id, kind, occurred_at, meeting_mode, body, created_at, updated_at)
             SELECT id, application_id, 'email', received_at, NULL, body, created_at, updated_at
             FROM application_emails;
             DROP TABLE application_emails;",
        )?;
    }
    conn.execute(
        "DELETE FROM application_events
         WHERE kind = 'note' AND note LIKE 'Email: %' AND correspondence_id IS NULL",
        [],
    )?;
    Ok(())
}

/// True when a table with this name exists in the database.
fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![table],
        |row| row.get::<_, bool>(0),
    )
}

/// True when the given table has a column with this name.
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name.eq_ignore_ascii_case(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> rusqlite::Result<()> {
    if !column_exists(conn, table, column)? {
        let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {decl}");
        conn.execute_batch(&sql)?;
    }
    Ok(())
}

/// One-time upgrade: replaces the old free-text `salary` column with
/// structured (amount, currency, period) columns, porting existing values.
fn upgrade_salary_columns(conn: &Connection) -> rusqlite::Result<()> {
    ensure_column(conn, "applications", "salary_amount", "REAL")?;
    ensure_column(
        conn,
        "applications",
        "salary_currency",
        "TEXT NOT NULL DEFAULT 'USD'",
    )?;
    ensure_column(
        conn,
        "applications",
        "salary_period",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    if !column_exists(conn, "applications", "salary")? {
        return Ok(()); // fresh install; nothing to port
    }

    let mut stmt = conn.prepare(
        "SELECT id, salary FROM applications WHERE salary IS NOT NULL AND TRIM(salary) <> ''",
    )?;
    let rows: Vec<(i64, String)> =
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
    for (id, text) in rows {
        let (amount, period) = parse_legacy_salary(&text);
        conn.execute(
            "UPDATE applications SET salary_amount = ?1, salary_period = ?2 WHERE id = ?3",
            params![amount, period, id],
        )?;
    }
    conn.execute_batch("ALTER TABLE applications DROP COLUMN salary;")?;
    Ok(())
}

/// Best-effort parse of the old free-text salary into (amount, period).
fn parse_legacy_salary(text: &str) -> (Option<f64>, &'static str) {
    let lower = text.to_lowercase();
    let period = if lower.contains("hr") || lower.contains("hour") {
        "hourly"
    } else if lower.contains("contract") {
        "contract"
    } else if lower.contains("/mo") || lower.contains("month") {
        "monthly"
    } else if lower.contains("other") {
        "other"
    } else {
        "yearly"
    };
    let digits: String = text
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect::<String>()
        .replace(',', "");
    let amount = digits.parse::<f64>().ok();
    (amount, period)
}
