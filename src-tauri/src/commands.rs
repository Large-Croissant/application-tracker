use crate::db::{now_iso, DbState};
use crate::models::{Application, ApplicationInput};
use std::sync::MutexGuard;
use rusqlite::{params, Connection, Row};
use tauri::State;

/// Maps database errors to user-facing messages.
fn err_msg(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::QueryReturnedNoRows => "Application not found.".to_string(),
        e => e.to_string(),
    }
}

/// Locks the shared connection; the guard lives for the duration of the command.
fn lock_db<'a>(state: &'a State<'a, DbState>) -> Result<MutexGuard<'a, Connection>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Database connection poisoned".to_string())
}

fn application_from_row(row: &Row) -> rusqlite::Result<Application> {
    Ok(Application {
        id: row.get("id")?,
        company: row.get("company")?,
        role: row.get("role")?,
        status: row.get("status")?,
        salary_amount: row.get("salary_amount")?,
        salary_currency: row.get("salary_currency")?,
        salary_period: row.get("salary_period")?,
        source: row.get("source")?,
        posting_url: row.get("posting_url")?,
        location: row.get("location")?,
        work_mode: row.get("work_mode")?,
        contact_name: row.get("contact_name")?,
        contact_email: row.get("contact_email")?,
        notes: row.get("notes")?,
        applied_at: row.get("applied_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn fetch_application(conn: &Connection, id: i64) -> rusqlite::Result<Application> {
    conn.query_row(
        "SELECT * FROM applications WHERE id = ?1",
        params![id],
        application_from_row,
    )
}

fn insert_application(conn: &Connection, input: &ApplicationInput) -> rusqlite::Result<i64> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO applications
            (company, role, status, source, posting_url, location, work_mode,
             salary_amount, salary_currency, salary_period,
             contact_name, contact_email, notes, applied_at,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
        params![
            input.company,
            input.role,
            input.status,
            input.source,
            input.posting_url,
            input.location,
            input.work_mode,
            input.salary_amount,
            input.salary_currency,
            input.salary_period,
            input.contact_name,
            input.contact_email,
            input.notes,
            input.applied_at,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Updates the given application and returns its fresh row.
fn save_and_fetch(
    conn: &Connection,
    id: i64,
    input: &ApplicationInput,
) -> rusqlite::Result<Application> {
    conn.execute(
        "UPDATE applications SET
            company = ?1, role = ?2, status = ?3, source = ?4,
            posting_url = ?5, location = ?6, work_mode = ?7,
            salary_amount = ?8, salary_currency = ?9, salary_period = ?10,
            contact_name = ?11, contact_email = ?12, notes = ?13,
            applied_at = ?14, updated_at = ?15
         WHERE id = ?16",
        params![
            input.company,
            input.role,
            input.status,
            input.source,
            input.posting_url,
            input.location,
            input.work_mode,
            input.salary_amount,
            input.salary_currency,
            input.salary_period,
            input.contact_name,
            input.contact_email,
            input.notes,
            input.applied_at,
            now_iso(),
            id,
        ],
    )?;
    let deleted = conn.query_row("SELECT changes() = 0", [], |row| row.get::<_, bool>(0))?;
    if deleted {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    fetch_application(conn, id)
}

fn validate(input: &ApplicationInput) -> Result<(), String> {
    if input.company.trim().is_empty() {
        return Err("Company is required.".into());
    }
    if input.role.trim().is_empty() {
        return Err("Role is required.".into());
    }
    if input.status.trim().is_empty() {
        return Err("Status is required.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_applications(state: State<DbState>) -> Result<Vec<Application>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare("SELECT * FROM applications ORDER BY created_at DESC, id DESC")
        .map_err(err_msg)?;
    let rows = stmt.query_map([], application_from_row).map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn create_application(
    input: ApplicationInput,
    state: State<DbState>,
) -> Result<Application, String> {
    validate(&input)?;
    let conn = lock_db(&state)?;
    let id = insert_application(&conn, &input).map_err(err_msg)?;
    fetch_application(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn update_application(
    id: i64,
    input: ApplicationInput,
    state: State<DbState>,
) -> Result<Application, String> {
    validate(&input)?;
    let conn = lock_db(&state)?;
    save_and_fetch(&conn, id, &input).map_err(err_msg)
}

#[tauri::command]
pub fn delete_application(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    conn.execute("DELETE FROM applications WHERE id = ?1", params![id])
        .map_err(err_msg)?;
    Ok(true)
}
