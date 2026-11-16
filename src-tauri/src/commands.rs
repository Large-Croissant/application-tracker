use crate::db::{now_iso, tombstone_app_tree, tombstone_by_ids, record_tombstones, DbState};
use crate::models::{
    Application, ApplicationCorrespondence, ApplicationEvent, ApplicationInput,
    CorrespondenceInput, EventInput, ImportBatch, ImportResult, PreparedAnswer, ProfileField,
    ReferenceContact, AnswerInput, ReferenceInput, ResumeInput, ResumeVersion,
};
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
        salary_amount_max: row.get("salary_amount_max")?,
        salary_currency: row.get("salary_currency")?,
        salary_period: row.get("salary_period")?,
        source: row.get("source")?,
        posting_url: row.get("posting_url")?,
        location: row.get("location")?,
        work_mode: row.get("work_mode")?,
        contact_name: row.get("contact_name")?,
        contact_email: row.get("contact_email")?,
        notes: row.get("notes")?,
        posting_text: row.get("posting_text")?,
        applied_at: row.get("applied_at")?,
        next_followup_at: row.get("next_followup_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn event_from_row(row: &Row) -> rusqlite::Result<ApplicationEvent> {
    Ok(ApplicationEvent {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        occurred_at: row.get("occurred_at")?,
        kind: row.get("kind")?,
        note: row.get("note")?,
        correspondence_id: row.get("correspondence_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn event_kind_valid(kind: &str) -> bool {
    matches!(
        kind,
        "note" | "call" | "interview" | "offer" | "decision" | "status_change" | "email" | "meeting"
    )
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
             salary_amount, salary_amount_max, salary_currency, salary_period,
             contact_name, contact_email, notes, posting_text,
             applied_at, next_followup_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)",
        params![
            input.company,
            input.role,
            input.status,
            input.source,
            input.posting_url,
            input.location,
            input.work_mode,
            input.salary_amount,
            input.salary_amount_max,
            input.salary_currency,
            input.salary_period,
            input.contact_name,
            input.contact_email,
            input.notes,
            input.posting_text,
            input.applied_at,
            input.next_followup_at,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Updates the given application and returns its fresh row.
/// When the status changes, a `status_change` timeline event is auto-written.
fn save_and_fetch(
    conn: &Connection,
    id: i64,
    input: &ApplicationInput,
) -> rusqlite::Result<Application> {
    let previous_status: Option<String> = conn
        .query_row(
            "SELECT status FROM applications WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .ok();

    conn.execute(
        "UPDATE applications SET
            company = ?1, role = ?2, status = ?3, source = ?4,
            posting_url = ?5, location = ?6, work_mode = ?7,
            salary_amount = ?8, salary_amount_max = ?9, salary_currency = ?10, salary_period = ?11,
            contact_name = ?12, contact_email = ?13, notes = ?14,
            posting_text = ?15, applied_at = ?16, next_followup_at = ?17,
            updated_at = ?18
         WHERE id = ?19",
        params![
            input.company,
            input.role,
            input.status,
            input.source,
            input.posting_url,
            input.location,
            input.work_mode,
            input.salary_amount,
            input.salary_amount_max,
            input.salary_currency,
            input.salary_period,
            input.contact_name,
            input.contact_email,
            input.notes,
            input.posting_text,
            input.applied_at,
            input.next_followup_at,
            now_iso(),
            id,
        ],
    )?;
    let deleted = conn.query_row("SELECT changes() = 0", [], |row| row.get::<_, bool>(0))?;
    if deleted {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    // Log stage transitions so the timeline keeps history alive.
    if let Some(old) = previous_status {
        if old != input.status {
            let now = to_local_datetime();
            insert_event(
                conn,
                id,
                &now,
                "status_change",
                &format!("{old} → {}", input.status),
            )?;
        }
    }
    fetch_application(conn, id)
}

/// Current local calendar date as `YYYY-MM-DD`.
fn to_local_date() -> String {
    use chrono::Local;
    Local::now().format("%Y-%m-%d").to_string()
}

/// Current local date and time as `YYYY-MM-DDTHH:MM`.
fn to_local_datetime() -> String {
    use chrono::Local;
    Local::now().format("%Y-%m-%dT%H:%M").to_string()
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
    // A range only makes sense with its low end above its high end checked out.
    if let (Some(min), Some(max)) = (input.salary_amount, input.salary_amount_max) {
        if max < min {
            return Err("The top of the pay range can't be below the bottom.".into());
        }
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

/// Tombstones every application matching a WHERE clause, including its
/// cascaded timeline events and correspondence. Returns how many matched.
fn tombstone_app_selection(
    conn: &Connection,
    where_sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<usize, String> {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare(&format!("SELECT id FROM applications WHERE {where_sql}"))
            .map_err(err_msg)?;
        let rows = stmt.query_map(params, |row| row.get(0)).map_err(err_msg)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err_msg)?
    };
    for id in &ids {
        tombstone_app_tree(conn, *id).map_err(err_msg)?;
    }
    Ok(ids.len())
}

#[tauri::command]
pub fn delete_application(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    tombstone_app_tree(&conn, id).map_err(err_msg)?;
    conn.execute("DELETE FROM applications WHERE id = ?1", params![id])
        .map_err(err_msg)?;
    Ok(true)
}

/// Deletes a batch of applications in one transaction (timeline events and
/// correspondence go with them via FK cascade). Returns rows deleted.
#[tauri::command]
pub fn delete_applications(ids: Vec<i64>, state: State<DbState>) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let conn = lock_db(&state)?;
    let tx = conn.unchecked_transaction().map_err(err_msg)?;
    let mut deleted = 0_usize;
    for id in &ids {
        tombstone_app_tree(&tx, *id).map_err(err_msg)?;
    }
    {
        let mut stmt = tx
            .prepare("DELETE FROM applications WHERE id = ?1")
            .map_err(err_msg)?;
        for id in &ids {
            deleted += stmt.execute(params![id]).map_err(err_msg)?;
        }
    }
    tx.commit().map_err(err_msg)?;
    Ok(deleted)
}

/// Inserts a timeline event row and returns its id.
fn insert_event(
    conn: &Connection,
    application_id: i64,
    occurred_at: &str,
    kind: &str,
    note: &str,
) -> rusqlite::Result<i64> {
    insert_event_linked(conn, application_id, occurred_at, kind, note, None)
}

fn insert_event_linked(
    conn: &Connection,
    application_id: i64,
    occurred_at: &str,
    kind: &str,
    note: &str,
    correspondence_id: Option<i64>,
) -> rusqlite::Result<i64> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO application_events
            (application_id, occurred_at, kind, note, correspondence_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![application_id, occurred_at, kind, note, correspondence_id, now],
    )?;
    Ok(conn.last_insert_rowid())
}

fn fetch_event(conn: &Connection, id: i64) -> rusqlite::Result<ApplicationEvent> {
    conn.query_row(
        "SELECT * FROM application_events WHERE id = ?1",
        params![id],
        event_from_row,
    )
}

#[tauri::command]
pub fn list_events(
    application_id: i64,
    state: State<DbState>,
) -> Result<Vec<ApplicationEvent>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT * FROM application_events WHERE application_id = ?1
             ORDER BY occurred_at DESC, id DESC",
        )
        .map_err(err_msg)?;
    let rows = stmt
        .query_map(params![application_id], event_from_row)
        .map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn list_all_events(state: State<DbState>) -> Result<Vec<ApplicationEvent>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT * FROM application_events
             ORDER BY application_id ASC, occurred_at ASC, id ASC",
        )
        .map_err(err_msg)?;
    let rows = stmt.query_map([], event_from_row).map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn add_event(
    application_id: i64,
    input: EventInput,
    state: State<DbState>,
) -> Result<ApplicationEvent, String> {
    if !event_kind_valid(&input.kind) {
        return Err("Unknown event kind.".into());
    }
    let conn = lock_db(&state)?;
    let occurred = input
        .occurred_at
        .filter(|date| !date.trim().is_empty())
        .unwrap_or_else(to_local_date);
    let id = insert_event(&conn, application_id, &occurred, &input.kind, &input.note)
        .map_err(err_msg)?;
    fetch_event(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn update_event(
    id: i64,
    input: EventInput,
    state: State<DbState>,
) -> Result<ApplicationEvent, String> {
    if !event_kind_valid(&input.kind) {
        return Err("Unknown event kind.".into());
    }
    let conn = lock_db(&state)?;
    let occurred = input
        .occurred_at
        .filter(|date| !date.trim().is_empty())
        .unwrap_or_else(to_local_date);
    conn.execute(
        "UPDATE application_events SET occurred_at = ?1, kind = ?2, note = ?3, updated_at = ?4
         WHERE id = ?5",
        params![occurred, input.kind, input.note, now_iso(), id],
    )
    .map_err(err_msg)?;
    fetch_event(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn delete_event(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    tombstone_by_ids(&conn, "application_events", &[id]).map_err(err_msg)?;
    conn.execute("DELETE FROM application_events WHERE id = ?1", params![id])
        .map_err(err_msg)?;
    Ok(true)
}

fn correspondence_kind_valid(kind: &str) -> bool {
    matches!(kind, "email" | "call" | "meeting")
}

fn correspondence_from_row(row: &Row) -> rusqlite::Result<ApplicationCorrespondence> {
    Ok(ApplicationCorrespondence {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        kind: row.get("kind")?,
        occurred_at: row.get("occurred_at")?,
        meeting_mode: row.get("meeting_mode")?,
        body: row.get("body")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn fetch_correspondence(conn: &Connection, id: i64) -> rusqlite::Result<ApplicationCorrespondence> {
    conn.query_row(
        "SELECT * FROM application_correspondence WHERE id = ?1",
        params![id],
        correspondence_from_row,
    )
}

fn insert_correspondence(
    conn: &Connection,
    application_id: i64,
    kind: &str,
    occurred_at: &str,
    meeting_mode: Option<&str>,
    body: &str,
) -> rusqlite::Result<i64> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO application_correspondence
            (application_id, kind, occurred_at, meeting_mode, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![application_id, kind, occurred_at, meeting_mode, body, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Validates the correspondence payload and returns the normalized parts.
fn validate_correspondence(input: &CorrespondenceInput) -> Result<(String, Option<String>), String> {
    if input.body.trim().is_empty() {
        return Err("Details/body is required.".into());
    }
    let kind = input
        .kind
        .as_deref()
        .unwrap_or("email")
        .trim()
        .to_lowercase();
    if !correspondence_kind_valid(&kind) {
        return Err("Unknown correspondence type.".into());
    }
    let meeting_mode: Option<String> = if kind == "meeting" {
        match input.meeting_mode.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => {
                if !matches!(m, "virtual" | "in_person") {
                    return Err("Meeting mode must be virtual or in_person.".into());
                }
                Some(m.to_string())
            }
            None => None,
        }
    } else {
        None
    };
    Ok((kind, meeting_mode))
}

#[tauri::command]
pub fn list_correspondence(
    application_id: i64,
    state: State<DbState>,
) -> Result<Vec<ApplicationCorrespondence>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT * FROM application_correspondence WHERE application_id = ?1
             ORDER BY occurred_at DESC, id DESC",
        )
        .map_err(err_msg)?;
    let rows = stmt
        .query_map(params![application_id], correspondence_from_row)
        .map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn add_correspondence(
    application_id: i64,
    input: CorrespondenceInput,
    state: State<DbState>,
) -> Result<ApplicationCorrespondence, String> {
    let (kind, meeting_mode) = validate_correspondence(&input)?;
    let conn = lock_db(&state)?;
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM applications WHERE id = ?1)",
            params![application_id],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !exists {
        return Err("Application not found.".to_string());
    }
    let occurred = input
        .occurred_at
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(to_local_date);
    let id = insert_correspondence(
        &conn,
        application_id,
        &kind,
        &occurred,
        meeting_mode.as_deref(),
        &input.body,
    )
    .map_err(err_msg)?;

    // A first-line preview keeps the intro readable inside the body.
    let first_line: String = first_line_of(&input.body);
    insert_event_linked(
        &conn,
        application_id,
        &occurred,
        &kind,
        &first_line,
        Some(id),
    )
    .map_err(err_msg)?;

    // Optional one-step status bump together with the correspondence item.
    if let Some(new_status) = input
        .follow_up_status
        .filter(|value| !value.trim().is_empty())
    {
        let previous: String = conn
            .query_row(
                "SELECT status FROM applications WHERE id = ?1",
                params![application_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        if new_status != previous {
            conn.execute(
                "UPDATE applications SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![new_status, now_iso(), application_id],
            )
            .map_err(err_msg)?;
            insert_event(
                &conn,
                application_id,
                &occurred,
                "status_change",
                &format!("{previous} → {new_status}"),
            )
            .map_err(err_msg)?;
        }
    }

    fetch_correspondence(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn update_correspondence(
    id: i64,
    input: CorrespondenceInput,
    state: State<DbState>,
) -> Result<ApplicationCorrespondence, String> {
    let (kind, meeting_mode) = validate_correspondence(&input)?;
    let conn = lock_db(&state)?;
    let occurred = input
        .occurred_at
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(to_local_date);
    conn.execute(
        "UPDATE application_correspondence
         SET kind = ?1, occurred_at = ?2, meeting_mode = ?3, body = ?4, updated_at = ?5
         WHERE id = ?6",
        params![kind, occurred, meeting_mode, input.body, now_iso(), id],
    )
    .map_err(err_msg)?;
    // Keep the linked timeline entry in step with the edited item.
    let first_line: String = first_line_of(&input.body);
    conn.execute(
        "UPDATE application_events
         SET occurred_at = ?1, kind = ?2, note = ?3, updated_at = ?4
         WHERE correspondence_id = ?5",
        params![occurred, kind, first_line, now_iso(), id],
    )
    .map_err(err_msg)?;
    fetch_correspondence(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn delete_correspondence(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    // The linked timeline entry travels with the item (single source of truth).
    tombstone_by_ids(&conn, "application_correspondence", &[id]).map_err(err_msg)?;
    {
        let mut stmt = conn
            .prepare("SELECT uuid FROM application_events WHERE correspondence_id = ?1")
            .map_err(err_msg)?;
        let uuids: Vec<String> = stmt
            .query_map(params![id], |row| row.get(0))
            .map_err(err_msg)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err_msg)?;
        record_tombstones(&conn, "application_events", &uuids).map_err(err_msg)?;
    }
    conn.execute(
        "DELETE FROM application_events WHERE correspondence_id = ?1",
        params![id],
    )
    .map_err(err_msg)?;
    conn.execute(
        "DELETE FROM application_correspondence WHERE id = ?1",
        params![id],
    )
    .map_err(err_msg)?;
    Ok(true)
}

/// First non-empty line of a body, trimmed for use as a preview note.
fn first_line_of(body: &str) -> String {
    body.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect()
}

// ---------- Sample data (evaluate Insights before real data arrives) ----------
//
// Everything created here is prefixed "Sample · " so it can be removed again
// with one click without touching real rows. Transitions recorded as
// status_change events use the same "old → new" note shape the app writes.

const SAMPLE_PREFIX: &str = "Sample · ";
const ARROW_SEP: &str = " → ";

/// Tiny deterministic RNG: repeat clicks reproduce the same dataset.
struct SampleRng(u64);
impl SampleRng {
    fn pick(&mut self, n: u64) -> u64 {
        let mut x = self.0.max(1);
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D)) % n
    }
}

/// The forward-only, event chain consistent with a final status.
fn sample_transitions(final_status: &str, rng: &mut SampleRng) -> Vec<(&'static str, &'static str)> {
    let mut through_ack = |_from: &str, to: &'static str, ack: &'static str| -> Vec<(&'static str, &'static str)> {
        if rng.pick(2) == 0 {
            vec![("applied", to)]
        } else {
            vec![("applied", ack), (ack, to)]
        }
    };
    match final_status {
        "applied" => vec![],
        "acknowledged" => vec![("applied", "acknowledged")],
        "interviewing" => vec![
            ("applied", "acknowledged"),
            ("acknowledged", "interviewing"),
        ],
        "offer" => vec![
            ("applied", "acknowledged"),
            ("acknowledged", "interviewing"),
            ("interviewing", "offer"),
        ],
        "accepted" => vec![
            ("applied", "acknowledged"),
            ("acknowledged", "interviewing"),
            ("interviewing", "offer"),
            ("offer", "accepted"),
        ],
        "rejected" => through_ack("applied", "rejected", "acknowledged"),
        "ghosted" => through_ack("applied", "ghosted", "acknowledged"),
        "withdrawn" => vec![("applied", "withdrawn")],
        _ => vec![],
    }
}

#[tauri::command]
pub fn seed_sample_data(state: State<DbState>) -> Result<usize, String> {
    use chrono::{Duration, Local, Months};

    const COMPANIES: [&str; 24] = [
        "Netflix", "Stripe", "Figma", "Notion", "Airbnb", "Shopify", "Linear", "Datadog",
        "Plaid", "Ramp", "Vercel", "Retool", "Anthropic", "OpenAI", "Gusto", "Brex",
        "DoorDash", "Uber", "Lyft", "Coinbase", "Roblox", "Snowflake", "Twilio", "Atlassian",
    ];
    const ROLES: [&str; 14] = [
        "Senior Software Engineer",
        "Software Engineer, Fullstack",
        "Staff Backend Engineer",
        "Software Engineer II",
        "Frontend Engineer",
        "Platform Engineer",
        "DevOps Engineer",
        "Software Engineer, Infrastructure",
        "Fullstack Engineer",
        "Backend Engineer",
        "Software Engineer III",
        "Senior Fullstack Developer",
        "Machine Learning Engineer",
        "Site Reliability Engineer",
    ];
    const LOCATIONS: [&str; 8] = [
        "New York, NY", "San Francisco, CA", "Seattle, WA", "Austin, TX",
        "Boston, MA", "Chicago, IL", "Denver, CO", "Atlanta, GA",
    ];
    const SOURCES: [&str; 6] = [
        "LinkedIn", "Indeed", "Company site", "Referral", "Wellfound", "Hiring cafe",
    ];

    // Fixed status distribution across 42 sample applications.
    let statuses: [&str; 42] = [
        "wishlist", "wishlist", "wishlist", "wishlist", "wishlist", "wishlist",
        "applied", "applied", "applied", "applied", "applied",
        "acknowledged", "acknowledged", "acknowledged", "acknowledged",
        "interviewing", "interviewing", "interviewing", "interviewing",
        "offer", "offer", "accepted", "rejected", "rejected", "rejected", "rejected",
        "rejected", "rejected", "rejected", "rejected", "rejected", "rejected",
        "rejected", "ghosted", "ghosted", "ghosted", "ghosted", "ghosted", "ghosted",
        "withdrawn", "withdrawn", "applied",
    ];

    let conn = lock_db(&state)?;
    let tx = conn.unchecked_transaction().map_err(err_msg)?;
    let mut rng = SampleRng(0x53a1_e12b_00d5_c4fe);
    let today = Local::now().date_naive();
    let earliest = today - Duration::days(235);
    let now = now_iso();
    let mut inserted = 0_usize;

    for (i, status) in statuses.iter().enumerate() {
        let mut company = COMPANIES[i % COMPANIES.len()].to_string();
        if i >= COMPANIES.len() {
            company.push_str(" — round 2");
        }
        let role = ROLES[(i * 5 + 3) % ROLES.len()];
        let location = LOCATIONS[rng.pick(LOCATIONS.len() as u64) as usize];
        let source = SOURCES[rng.pick(SOURCES.len() as u64) as usize];
        let work_mode = ["", "onsite", "hybrid", "remote"][rng.pick(4) as usize];

        let is_wishlist = *status == "wishlist";
        // Applied date: seeded over the last ~8 months.
        let mut applied: Option<chrono::NaiveDate> = None;
        if !is_wishlist {
            let months_back = rng.pick(8) as u32;
            let base = today.checked_sub_months(Months::new(months_back)).unwrap_or(today);
            applied = Some((base - Duration::days(rng.pick(26) as i64)).max(earliest));
        }
        let applied_at = applied.map(|d| d.format("%Y-%m-%d").to_string());

        // Pay: mostly a yearly number, sometimes a range, occasionally hourly.
        let mut salary: Option<f64> = None;
        let mut salary_max: Option<f64> = None;
        let mut period = "";
        if !is_wishlist || rng.pick(4) == 0 {
            match rng.pick(7) {
                0 => {
                    // Hourly contract role.
                    let rate = 35 + rng.pick(31) as i64;
                    salary = Some(rate as f64);
                    if rng.pick(4) == 0 {
                        salary_max = Some(rate as f64 + rng.pick(11) as f64 + 5.0);
                    }
                    period = "hourly";
                }
                _ => {
                    let base_salary = 72000 + rng.pick(26) as i64 * 5000;
                    salary = Some(base_salary as f64);
                    if rng.pick(4) == 0 {
                        salary_max =
                            Some((base_salary + 5000 + rng.pick(6) as i64 * 5000) as f64);
                    }
                    period = "yearly";
                }
            }
        }

        tx.execute(
            "INSERT INTO applications
                (company, role, status, source, posting_url, location, work_mode,
                 salary_amount, salary_amount_max, salary_currency, salary_period,
                 contact_name, contact_email, notes, posting_text,
                 applied_at, next_followup_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)",
            params![
                format!("{SAMPLE_PREFIX}{company}"),
                role,
                status,
                source,
                "",
                location,
                work_mode,
                salary,
                salary_max,
                "USD",
                period,
                "",
                "",
                if is_wishlist { "Wishlist — not sent yet." } else { "Sample application." },
                "",
                applied_at,
                Option::<String>::None,
                now,
            ],
        )
        .map_err(err_msg)?;
        inserted += 1;
        if is_wishlist {
            continue;
        }
        let app_id = tx.last_insert_rowid();
        let applied_day = applied.unwrap_or(today);

        // Starting note + forward transcript of moves.
        let mut events: Vec<(String, &'static str, String)> =
            vec![(applied_day.format("%Y-%m-%d").to_string(), "note", "Applied online".into())];
        let mut day = applied_day + Duration::days(1 + rng.pick(4) as i64);
        for (_, (from, to)) in sample_transitions(status, &mut rng).into_iter().enumerate() {
            if day > today {
                break; // never record events in the future
            }
            events.push((day.format("%Y-%m-%d").to_string(), "status_change", format!("{from}{ARROW_SEP}{to}")));
            day = day + Duration::days(1 + rng.pick(7) as i64);
            if to == "interviewing" {
                events.push((day.format("%Y-%m-%d").to_string(), "interview", "Technical interview with the team".into()));
            }
        }
        if *status == "offer" && day <= today {
            events.push((day.format("%Y-%m-%d").to_string(), "offer", "Verbal offer received".into()));
        }
        if *status == "accepted" && day <= today {
            events.push((day.format("%Y-%m-%d").to_string(), "decision", "Signed the offer letter".into()));
        }

        for (occurred, kind, note) in events {
            tx.execute(
                "INSERT INTO application_events
                    (application_id, occurred_at, kind, note, correspondence_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
                params![app_id, occurred, kind, note, now],
            )
            .map_err(err_msg)?;
        }
    }
    tx.commit().map_err(err_msg)?;
    Ok(inserted)
}

/// Removes everything the sample seeder created (matched by company prefix).
#[tauri::command]
pub fn delete_sample_data(state: State<DbState>) -> Result<usize, String> {
    let conn = lock_db(&state)?;
    let prefix = format!("{SAMPLE_PREFIX}%");
    let deleted = tombstone_app_selection(&conn, "company LIKE ?1", &[&prefix])?;
    conn.execute(
        "DELETE FROM applications WHERE company LIKE ?1",
        params![prefix],
    )
    .map_err(err_msg)?;
    Ok(deleted)
}

/// Imports a batch of applications with prebuilt timeline events in one
/// transaction — used by the Flosa import. Nothing partial is written: any
/// invalid row aborts the whole batch.
///
/// `created_at`/`updated_at` reflect the application's real history (applied
/// date and latest event) instead of the import moment, so the table doesn't
/// claim everything was touched today.
#[tauri::command]
pub fn import_applications(
    batch: ImportBatch,
    state: State<DbState>,
) -> Result<ImportResult, String> {
    let conn = lock_db(&state)?;
    let tx = conn.unchecked_transaction().map_err(err_msg)?;
    let mut replaced = 0_usize;
    if batch.replace {
        tombstone_app_selection(&tx, "source = 'Flosa import'", &[])?;
        replaced = tx
            .execute("DELETE FROM applications WHERE source = 'Flosa import'", [])
            .map_err(err_msg)?;
    }
    let mut imported = 0_usize;
    let mut events_total = 0_usize;
    for (i, item) in batch.applications.iter().enumerate() {
        if item.app.company.trim().is_empty() || item.app.role.trim().is_empty() {
            return Err(format!(
                "Import row {} is missing a company or role.",
                i + 1
            ));
        }
        for ev in &item.events {
            if !event_kind_valid(&ev.kind) {
                return Err(format!(
                    "Import row {} has unknown event kind '{}'.",
                    i + 1,
                    ev.kind
                ));
            }
            if ev.occurred_at.trim().is_empty() {
                return Err(format!("Import row {} has an event with no date.", i + 1));
            }
        }
        let id = insert_application(&tx, &item.app).map_err(err_msg)?;
        imported += 1;

        // Real-history timestamps: applied date as creation, latest event
        // (or the applied date) as last update. Dates are `YYYY-MM-DD`.
        let created_at = item
            .app
            .applied_at
            .clone()
            .unwrap_or_else(now_iso)
            .split('T')
            .next()
            .unwrap_or("")
            .to_string();
        let mut latest = created_at.clone();
        for ev in &item.events {
            let d = ev.occurred_at.split('T').next().unwrap_or("").to_string();
            if d.as_str() > latest.as_str() {
                latest = d;
            }
            insert_event(&tx, id, &ev.occurred_at, &ev.kind, &ev.note).map_err(err_msg)?;
            events_total += 1;
        }
        let stamp = |d: &str| format!("{d}T00:00:00.000Z");
        tx.execute(
            "UPDATE applications SET created_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![stamp(&created_at), stamp(&latest), id],
        )
        .map_err(err_msg)?;
    }
    tx.commit().map_err(err_msg)?;
    Ok(ImportResult { imported, events: events_total, replaced })
}

/// Removes applications imported earlier from Flosa (matched by source tag),
/// so a corrected import can replace them cleanly. Returns rows deleted.
#[tauri::command]
pub fn delete_imported_flosa(state: State<DbState>) -> Result<usize, String> {
    let conn = lock_db(&state)?;
    tombstone_app_selection(&conn, "source = 'Flosa import'", &[])?;
    let deleted = conn
        .execute(
            "DELETE FROM applications WHERE source = 'Flosa import'",
            [],
        )
        .map_err(err_msg)?;
    Ok(deleted)
}

// ---------- Vault: profile, references, answers, resumes ----------

fn profile_from_row(row: &Row) -> rusqlite::Result<ProfileField> {
    Ok(ProfileField {
        key: row.get("field_key")?,
        value: row.get("value")?,
        updated_at: row.get("updated_at")?,
    })
}

#[tauri::command]
pub fn list_profile(state: State<DbState>) -> Result<Vec<ProfileField>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare("SELECT * FROM profile ORDER BY sort_order ASC, field_key ASC")
        .map_err(err_msg)?;
    let rows = stmt.query_map([], profile_from_row).map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

/// Upserts a profile field. An empty value deletes the row (the field
/// disappears from the list; setting it again re-creates it).
#[tauri::command]
pub fn set_profile(
    key: String,
    value: String,
    state: State<DbState>,
) -> Result<ProfileField, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Field name is required.".into());
    }
    let conn = lock_db(&state)?;
    let now = now_iso();
    if value.trim().is_empty() {
        record_tombstones(&conn, "profile", &[key.clone()]).map_err(err_msg)?;
        conn.execute(
            "DELETE FROM profile WHERE field_key = ?1",
            params![key],
        )
        .map_err(err_msg)?;
        return Ok(ProfileField {
            key,
            value: String::new(),
            updated_at: now,
        });
    }
    conn.execute(
        "INSERT INTO profile (field_key, value, updated_at, sort_order)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM profile))
         ON CONFLICT(field_key) DO UPDATE SET value = ?2, updated_at = ?3",
        params![key, value, now],
    )
    .map_err(err_msg)?;
    Ok(ProfileField { key, value, updated_at: now })
}

/// Stores the display order of profile fields (the frontend sends the full
/// ordered key list after a reorder).
#[tauri::command]
pub fn reorder_profile(keys: Vec<String>, state: State<DbState>) -> Result<(), String> {
    let conn = lock_db(&state)?;
    for (i, key) in keys.iter().enumerate() {
        conn.execute(
            "UPDATE profile SET sort_order = ?1 WHERE field_key = ?2",
            params![i as i64, key],
        )
        .map_err(err_msg)?;
    }
    Ok(())
}

fn reference_from_row(row: &Row) -> rusqlite::Result<ReferenceContact> {
    Ok(ReferenceContact {
        id: row.get("id")?,
        name: row.get("name")?,
        relationship: row.get("relationship")?,
        title: row.get("title")?,
        company: row.get("company")?,
        email: row.get("email")?,
        phone: row.get("phone")?,
        linkedin: row.get("linkedin")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn fetch_reference(conn: &Connection, id: i64) -> rusqlite::Result<ReferenceContact> {
    conn.query_row(
        "SELECT * FROM reference_contacts WHERE id = ?1",
        params![id],
        reference_from_row,
    )
}

fn insert_reference(conn: &Connection, input: &ReferenceInput) -> rusqlite::Result<i64> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO reference_contacts
            (name, relationship, title, company, email, phone, linkedin, notes,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            input.name,
            input.relationship,
            input.title,
            input.company,
            input.email,
            input.phone,
            input.linkedin,
            input.notes,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn validate_reference(input: &ReferenceInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Name is required.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_references(state: State<DbState>) -> Result<Vec<ReferenceContact>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare("SELECT * FROM reference_contacts ORDER BY name ASC, id ASC")
        .map_err(err_msg)?;
    let rows = stmt.query_map([], reference_from_row).map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn add_reference(
    input: ReferenceInput,
    state: State<DbState>,
) -> Result<ReferenceContact, String> {
    validate_reference(&input)?;
    let conn = lock_db(&state)?;
    let id = insert_reference(&conn, &input).map_err(err_msg)?;
    fetch_reference(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn update_reference(
    id: i64,
    input: ReferenceInput,
    state: State<DbState>,
) -> Result<ReferenceContact, String> {
    validate_reference(&input)?;
    let conn = lock_db(&state)?;
    let now = now_iso();
    conn.execute(
        "UPDATE reference_contacts SET
            name = ?1, relationship = ?2, title = ?3, company = ?4,
            email = ?5, phone = ?6, linkedin = ?7, notes = ?8, updated_at = ?9
         WHERE id = ?10",
        params![
            input.name,
            input.relationship,
            input.title,
            input.company,
            input.email,
            input.phone,
            input.linkedin,
            input.notes,
            now,
            id,
        ],
    )
    .map_err(err_msg)?;
    fetch_reference(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn delete_reference(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    tombstone_by_ids(&conn, "reference_contacts", &[id]).map_err(err_msg)?;
    conn.execute("DELETE FROM reference_contacts WHERE id = ?1", params![id])
        .map_err(err_msg)?;
    Ok(true)
}

fn answer_from_row(row: &Row) -> rusqlite::Result<PreparedAnswer> {
    Ok(PreparedAnswer {
        id: row.get("id")?,
        title: row.get("title")?,
        body: row.get("body")?,
        category: row.get("category")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn fetch_answer(conn: &Connection, id: i64) -> rusqlite::Result<PreparedAnswer> {
    conn.query_row(
        "SELECT * FROM prepared_answers WHERE id = ?1",
        params![id],
        answer_from_row,
    )
}

fn validate_answer(input: &AnswerInput) -> Result<(), String> {
    if input.title.trim().is_empty() {
        return Err("Title is required.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_prepared_answers(state: State<DbState>) -> Result<Vec<PreparedAnswer>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare("SELECT * FROM prepared_answers ORDER BY updated_at DESC, id DESC")
        .map_err(err_msg)?;
    let rows = stmt.query_map([], answer_from_row).map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn add_prepared_answer(
    input: AnswerInput,
    state: State<DbState>,
) -> Result<PreparedAnswer, String> {
    validate_answer(&input)?;
    let conn = lock_db(&state)?;
    let now = now_iso();
    conn.execute(
        "INSERT INTO prepared_answers (title, body, category, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![input.title, input.body, input.category, now],
    )
    .map_err(err_msg)?;
    let id = conn.last_insert_rowid();
    fetch_answer(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn update_prepared_answer(
    id: i64,
    input: AnswerInput,
    state: State<DbState>,
) -> Result<PreparedAnswer, String> {
    validate_answer(&input)?;
    let conn = lock_db(&state)?;
    conn.execute(
        "UPDATE prepared_answers SET title = ?1, body = ?2, category = ?3, updated_at = ?4
         WHERE id = ?5",
        params![input.title, input.body, input.category, now_iso(), id],
    )
    .map_err(err_msg)?;
    fetch_answer(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn delete_prepared_answer(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    tombstone_by_ids(&conn, "prepared_answers", &[id]).map_err(err_msg)?;
    conn.execute("DELETE FROM prepared_answers WHERE id = ?1", params![id])
        .map_err(err_msg)?;
    Ok(true)
}

fn resume_from_row(row: &Row) -> rusqlite::Result<ResumeVersion> {
    Ok(ResumeVersion {
        id: row.get("id")?,
        name: row.get("name")?,
        file_name: row.get("file_name")?,
        notes: row.get("notes")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn fetch_resume(conn: &Connection, id: i64) -> rusqlite::Result<ResumeVersion> {
    conn.query_row(
        "SELECT * FROM resume_versions WHERE id = ?1",
        params![id],
        resume_from_row,
    )
}

fn validate_resume(input: &ResumeInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Version name is required.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_resumes(state: State<DbState>) -> Result<Vec<ResumeVersion>, String> {
    let conn = lock_db(&state)?;
    let mut stmt = conn
        .prepare("SELECT * FROM resume_versions ORDER BY updated_at DESC, id DESC")
        .map_err(err_msg)?;
    let rows = stmt.query_map([], resume_from_row).map_err(err_msg)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err_msg)
}

#[tauri::command]
pub fn add_resume(
    input: ResumeInput,
    state: State<DbState>,
) -> Result<ResumeVersion, String> {
    validate_resume(&input)?;
    let conn = lock_db(&state)?;
    let now = now_iso();
    conn.execute(
        "INSERT INTO resume_versions (name, file_name, notes, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![input.name, input.file_name, input.notes, input.content, now],
    )
    .map_err(err_msg)?;
    let id = conn.last_insert_rowid();
    fetch_resume(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn update_resume(
    id: i64,
    input: ResumeInput,
    state: State<DbState>,
) -> Result<ResumeVersion, String> {
    validate_resume(&input)?;
    let conn = lock_db(&state)?;
    conn.execute(
        "UPDATE resume_versions
         SET name = ?1, file_name = ?2, notes = ?3, content = ?4, updated_at = ?5
         WHERE id = ?6",
        params![input.name, input.file_name, input.notes, input.content, now_iso(), id],
    )
    .map_err(err_msg)?;
    fetch_resume(&conn, id).map_err(err_msg)
}

#[tauri::command]
pub fn delete_resume(id: i64, state: State<DbState>) -> Result<bool, String> {
    let conn = lock_db(&state)?;
    tombstone_by_ids(&conn, "resume_versions", &[id]).map_err(err_msg)?;
    conn.execute("DELETE FROM resume_versions WHERE id = ?1", params![id])
        .map_err(err_msg)?;
    Ok(true)
}
