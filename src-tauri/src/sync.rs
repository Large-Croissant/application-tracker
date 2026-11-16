//! Cloud sync over Dropbox: the whole dataset is exported as a JSON
//! snapshot, optionally encrypted end-to-end (passphrase → Argon2id key →
//! XChaCha20-Poly1305), then uploaded as one blob. Pull downloads, decrypts,
//! and replaces the local database in a single transaction (with a safety
//! backup written first).
//!
//! Sync config (App key, refresh token, preferences) lives in `sync.json`
//! next to the database. The passphrase is never stored unless the user
//! explicitly opts into "remember on this device".

use argon2::Argon2;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::db::{now_iso, record_tombstones, DbState};

/// Encrypted/unsigned blob magic: version byte follows ("1" = encrypted,
/// "0" = plaintext JSON, only when the user turned E2E off).
const MAGIC: &[u8] = b"JTSYNC";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

/// Path inside the (scoped) Dropbox app folder.
const CLOUD_PATH: &str = "/jobtracker-data.jtsync";

/// Tables in insert order (parents before children); export uses the same
/// list. `profile` is independent, applications precede their events.
const TABLES: [&str; 7] = [
    "resume_versions",
    "prepared_answers",
    "reference_contacts",
    "profile",
    "applications",
    "application_events",
    "application_correspondence",
];

// ---------- config ----------

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SyncConfig {
    app_key: String,
    refresh_token: String,
    /// End-to-end encryption on by default.
    encrypt: bool,
    /// Push the snapshot automatically when the app closes.
    #[serde(default = "default_true")]
    auto_sync: bool,
    remember_passphrase: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    passphrase: String,
    /// Dropbox revision seen at the last push/pull (conflict detection).
    last_known_rev: String,
    last_sync_at: String,
    /// SHA-256 of the snapshot as of the last push/pull; a different digest
    /// now means there are local changes not yet in the cloud.
    last_pushed_digest: String,
    /// PKCE verifier between "Connect" and "paste the code".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pkce_verifier: String,
    /// How many days of local backup files to keep (Settings → Backups).
    #[serde(default = "default_backup_days")]
    pub(crate) backup_days: u32,
}

fn default_true() -> bool {
    true
}

fn default_backup_days() -> u32 {
    14
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create data directory: {e}"))?;
    Ok(dir.join("sync.json"))
}

pub(crate) fn load_config(app: &tauri::AppHandle) -> Result<SyncConfig, String> {
    let path = config_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Corrupt sync config: {e}")),
        Err(_) => Ok(SyncConfig::default()),
    }
}

pub(crate) fn save_config(app: &tauri::AppHandle, config: &SyncConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("Cannot write sync config: {e}"))
}

/// Sync state shared across commands: the in-flight PKCE verifier.
pub struct SyncState {
    verifier: Mutex<Option<String>>,
}

impl SyncState {
    pub fn new() -> Self {
        Self { verifier: Mutex::new(None) }
    }
}

// ---------- crypto ----------

/// Derives the 32-byte data key from (passphrase, salt) with Argon2id.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

/// Packs the snapshot JSON into the wire blob (with or without encryption).
fn pack_blob(snapshot: &Json, encrypt: bool, passphrase: &str) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    if !encrypt {
        let mut blob = MAGIC.to_vec();
        blob.push(b'0');
        blob.push(b'\n');
        blob.extend_from_slice(&json);
        return Ok(blob);
    }
    if passphrase.trim().is_empty() {
        return Err("A passphrase is required for encrypted sync.".into());
    }
    let mut salt = [0u8; SALT_LEN];
    chacha20poly1305::aead::rand_core::OsRng.fill_bytes(&mut salt);
    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    chacha20poly1305::aead::rand_core::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, Payload { msg: &json, aad: MAGIC })
        .map_err(|_| "Encryption failed.".to_string())?;
    let mut blob = MAGIC.to_vec();
    blob.push(b'1');
    blob.push(b'\n');
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);
    Ok(blob)
}

/// Unpacks a downloaded blob back into snapshot JSON.
fn unpack_blob(blob: &[u8], passphrase: &str) -> Result<Json, String> {
    if blob.len() < MAGIC.len() + 2 || &blob[..MAGIC.len()] != MAGIC {
        return Err("This file is not a JobTracker sync blob.".into());
    }
    let mode = blob[MAGIC.len()];
    if blob[MAGIC.len() + 1] != b'\n' {
        return Err("Corrupt sync blob header.".into());
    }
    let rest = &blob[MAGIC.len() + 2..];
    match mode {
        b'0' => serde_json::from_slice(rest).map_err(|e| format!("Corrupt snapshot: {e}")),
        b'1' => {
            if rest.len() < SALT_LEN + NONCE_LEN + 16 {
                return Err("Corrupt encrypted blob.".into());
            }
            if passphrase.trim().is_empty() {
                return Err(
                    "This sync file is encrypted — enter your sync passphrase to pull it.".into(),
                );
            }
            let salt = &rest[..SALT_LEN];
            let nonce = XNonce::from_slice(&rest[SALT_LEN..SALT_LEN + NONCE_LEN]);
            let ct = &rest[SALT_LEN + NONCE_LEN..];
            let key = derive_key(passphrase, salt)?;
            let cipher = XChaCha20Poly1305::new((&key).into());
            let json = cipher
                .decrypt(nonce, Payload { msg: ct, aad: MAGIC })
                .map_err(|_| {
                    "Decryption failed — the passphrase is wrong or the file is damaged.".to_string()
                })?;
            serde_json::from_slice(&json).map_err(|e| format!("Corrupt snapshot: {e}"))
        }
        _ => Err(format!("Unknown sync blob version '{mode}'.")),
    }
}

// ---------- snapshot export / import (v2: uuid-based, mergeable) ----------

/// Root keys of a v2 snapshot that participate in the content digest.
const SNAPSHOT_KEYS: [&str; 8] = [
    "resume_versions",
    "prepared_answers",
    "reference_contacts",
    "profile",
    "applications",
    "application_events",
    "application_correspondence",
    "tombstones",
];

/// Stable content hash of a snapshot. Only the snapshot keys participate —
/// volatile fields (exportedAt) are excluded, so equal data → equal digest.
fn snapshot_digest(snapshot: &Json) -> String {
    let mut hasher = Sha256::new();
    for key in SNAPSHOT_KEYS {
        let empty = Json::Null;
        let bytes = serde_json::to_vec(snapshot.get(key).unwrap_or(&empty))
            .unwrap_or_default();
        hasher.update(&bytes);
        hasher.update(b"\x00"); // key boundary
    }
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(err)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

fn err(e: rusqlite::Error) -> String {
    format!("Sync database error: {e}")
}

type SqlCol = (&'static str, &'static str); // (SQL column, JSON key)

fn json_from_sql(v: SqlValue) -> Json {
    match v {
        SqlValue::Null => Json::Null,
        SqlValue::Integer(n) => json!(n),
        SqlValue::Real(f) => json!(f),
        SqlValue::Text(s) => json!(s),
        SqlValue::Blob(b) => json!(STANDARD.encode(b)),
    }
}

/// Exports one table as an array of JSON objects keyed by `cols`.
fn export_table(conn: &Connection, table: &str, cols: &[SqlCol]) -> Result<Vec<Json>, String> {
    let sql = format!(
        "SELECT {} FROM {table}",
        cols.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(", ")
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut obj = Map::new();
        for (i, (_, key)) in cols.iter().enumerate() {
            let v: SqlValue = row.get(i).map_err(err)?;
            obj.insert(key.to_string(), json_from_sql(v));
        }
        out.push(Json::Object(obj));
    }
    Ok(out)
}

/// Local id → uuid map for FK resolution during export/merge.
fn id_to_uuid_map(
    conn: &Connection,
    table: &str,
) -> Result<std::collections::HashMap<i64, String>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT id, uuid FROM {table} WHERE uuid <> ''"))
        .map_err(err)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(err)
}

// ---------- column maps (shared by export and merge) ----------

/// Content columns per synced table: (SQL column, JSON key). Export and
/// merge both use these so the two directions can never drift. The uuid and
/// local-FK columns are handled separately by each side.
const APP_COLS: &[SqlCol] = &[
    ("company", "company"),
    ("role", "role"),
    ("status", "status"),
    ("source", "source"),
    ("posting_url", "postingUrl"),
    ("location", "location"),
    ("work_mode", "workMode"),
    ("salary_amount", "salaryAmount"),
    ("salary_amount_max", "salaryAmountMax"),
    ("salary_currency", "salaryCurrency"),
    ("salary_period", "salaryPeriod"),
    ("contact_name", "contactName"),
    ("contact_email", "contactEmail"),
    ("notes", "notes"),
    ("posting_text", "postingText"),
    ("applied_at", "appliedAt"),
    ("next_followup_at", "nextFollowupAt"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
const EVENT_COLS: &[SqlCol] = &[
    ("occurred_at", "occurredAt"),
    ("kind", "kind"),
    ("note", "note"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
const CORR_COLS: &[SqlCol] = &[
    ("kind", "kind"),
    ("occurred_at", "occurredAt"),
    ("meeting_mode", "meetingMode"),
    ("body", "body"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
const REF_COLS: &[SqlCol] = &[
    ("name", "name"),
    ("relationship", "relationship"),
    ("title", "title"),
    ("company", "company"),
    ("email", "email"),
    ("phone", "phone"),
    ("linkedin", "linkedin"),
    ("notes", "notes"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
const ANSWER_COLS: &[SqlCol] = &[
    ("title", "title"),
    ("body", "body"),
    ("category", "category"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
const RESUME_COLS: &[SqlCol] = &[
    ("name", "name"),
    ("file_name", "fileName"),
    ("notes", "notes"),
    ("content", "content"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
/// profile is key-stable: `field_key` is both the SQL key and the sync
/// identity (tombstones record it under the table name "profile").
const PROFILE_COLS: &[SqlCol] = &[
    ("value", "value"),
    ("sort_order", "sortOrder"),
    ("updated_at", "updatedAt"),
];

/// Key column first, then the content columns (key never duplicated).
fn with_key(key_col: &'static str, key_json: &'static str, cols: &[SqlCol]) -> Vec<SqlCol> {
    let mut out = Vec::with_capacity(cols.len() + 1);
    out.push((key_col, key_json));
    out.extend(
        cols.iter()
            .copied()
            .filter(|(c, _)| *c != key_col),
    );
    out
}

/// Exports a v2 snapshot: uuid identities, uuid-based FK links (local integer
/// ids are device-private and never leave the machine), and tombstones.
fn export_snapshot(conn: &Connection) -> Result<Json, String> {
    let resume_map = id_to_uuid_map(conn, "resume_versions")?;
    let app_map = id_to_uuid_map(conn, "applications")?;
    let corr_map = id_to_uuid_map(conn, "application_correspondence")?;

    let mut root = Map::new();
    root.insert("app".into(), json!("jobtracker"));
    root.insert("version".into(), json!(2));
    root.insert("exportedAt".into(), json!(now_iso()));

    let mut app_cols = with_key("uuid", "uuid", APP_COLS);
    app_cols.push(("resume_version_id", "resumeVersionId")); // mapped below
    let mut apps = export_table(conn, "applications", &app_cols)?;
    for row in &mut apps {
        let Some(obj) = row.as_object_mut() else { continue };
        let rid = obj.remove("resumeVersionId").and_then(|v| v.as_i64());
        let ru = rid.and_then(|id| resume_map.get(&id)).cloned();
        obj.insert("resumeVersionUuid".into(), json!(ru));
    }
    root.insert("applications".into(), Json::Array(apps));

    let mut event_cols = with_key("uuid", "uuid", EVENT_COLS);
    event_cols.push(("application_id", "applicationId")); // mapped below
    event_cols.push(("correspondence_id", "correspondenceId"));
    let mut events = export_table(conn, "application_events", &event_cols)?;
    for row in &mut events {
        let Some(obj) = row.as_object_mut() else { continue };
        let aid = obj.remove("applicationId").and_then(|v| v.as_i64());
        let cid = obj.remove("correspondenceId").and_then(|v| v.as_i64());
        let au = aid.and_then(|id| app_map.get(&id)).cloned();
        let cu = cid.and_then(|id| corr_map.get(&id)).cloned();
        obj.insert("applicationUuid".into(), json!(au));
        obj.insert("correspondenceUuid".into(), json!(cu));
    }
    root.insert("application_events".into(), Json::Array(events));

    let mut corr_cols = with_key("uuid", "uuid", CORR_COLS);
    corr_cols.push(("application_id", "applicationId")); // mapped below
    let mut corr = export_table(conn, "application_correspondence", &corr_cols)?;
    for row in &mut corr {
        let Some(obj) = row.as_object_mut() else { continue };
        let aid = obj.remove("applicationId").and_then(|v| v.as_i64());
        let au = aid.and_then(|id| app_map.get(&id)).cloned();
        obj.insert("applicationUuid".into(), json!(au));
    }
    root.insert("application_correspondence".into(), Json::Array(corr));

    root.insert(
        "reference_contacts".into(),
        Json::Array(export_table(
            conn,
            "reference_contacts",
            &with_key("uuid", "uuid", REF_COLS),
        )?),
    );
    root.insert(
        "prepared_answers".into(),
        Json::Array(export_table(
            conn,
            "prepared_answers",
            &with_key("uuid", "uuid", ANSWER_COLS),
        )?),
    );
    root.insert(
        "resume_versions".into(),
        Json::Array(export_table(
            conn,
            "resume_versions",
            &with_key("uuid", "uuid", RESUME_COLS),
        )?),
    );
    root.insert(
        "profile".into(),
        Json::Array(export_table(
            conn,
            "profile",
            &with_key("field_key", "fieldKey", PROFILE_COLS),
        )?),
    );

    // Tombstones straight from sync_tombstones.
    let mut stmt = conn
        .prepare("SELECT table_name, uuid, deleted_at FROM sync_tombstones")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut tombs = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        tombs.push(json!({
            "table": row.get::<_, String>(0).map_err(err)?,
            "uuid": row.get::<_, String>(1).map_err(err)?,
            "deletedAt": row.get::<_, String>(2).map_err(err)?,
        }));
    }
    root.insert("tombstones".into(), Json::Array(tombs));

    Ok(Json::Object(root))
}

/// Replaces the local database with the snapshot in one transaction.
/// FK checks are deferred so table order can't break the import.
/// (Legacy v1 path — v2 snapshots go through `merge_snapshot`.)
fn import_snapshot(conn: &Connection, snapshot: &Json) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(err)?;
    let mut total = 0_usize;
    for table in TABLES {
        tx.execute(&format!("DELETE FROM {table}"), []).map_err(err)?;
        let cols = column_names(conn, table)?;
        let Some(rows) = snapshot.get(table).and_then(|v| v.as_array()) else {
            continue;
        };
        for row in rows {
            let Some(obj) = row.as_object() else { continue };
            let present: Vec<&String> =
                cols.iter().filter(|c| obj.contains_key(c.as_str())).collect();
            if present.is_empty() {
                continue;
            }
            let sql = format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                present.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", "),
                vec!["?"; present.len()].join(", ")
            );
            let vals: Vec<SqlValue> = present
                .iter()
                .map(|c| match &obj[c.as_str()] {
                    Json::Null => SqlValue::Null,
                    Json::Bool(b) => SqlValue::Integer(*b as i64),
                    Json::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            SqlValue::Integer(i)
                        } else {
                            SqlValue::Real(n.as_f64().unwrap_or(0.0))
                        }
                    }
                    Json::String(s) => SqlValue::Text(s.clone()),
                    _ => SqlValue::Null,
                })
                .collect();
            tx.execute(&sql, rusqlite::params_from_iter(vals))
                .map_err(err)?;
            total += 1;
        }
    }
    tx.commit().map_err(err)?;
    Ok(total)
}

// ---------- merge (v2: union by uuid, last-writer-wins, tombstones) ----------

/// Outcome of one pull-merge, for the status message.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct MergeStats {
    inserted: usize,
    updated: usize,
    /// Rows removed locally because an incoming tombstone outvoted them.
    tombstoned: usize,
}

/// Tables a tombstone may name (whitelist before any SQL interpolation).
fn tombstone_table_ok(table: &str) -> bool {
    matches!(
        table,
        "applications"
            | "application_events"
            | "application_correspondence"
            | "reference_contacts"
            | "prepared_answers"
            | "resume_versions"
            | "profile"
    )
}

/// JSON string field, rejecting empty strings.
fn jstr<'a>(row: &'a Json, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Json::as_str)
        .filter(|s| !s.is_empty())
}

/// Snapshot array for a key, or an empty slice.
fn rows_of<'a>(snapshot: &'a Json, key: &str) -> &'a [Json] {
    snapshot
        .get(key)
        .and_then(Json::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn json_to_sql(v: &Json) -> SqlValue {
    match v {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::Integer(*b as i64),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Null,
    }
}

/// uuid → local id map, used to attach children to their parents.
fn uuid_id_map(
    conn: &Connection,
    table: &str,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT uuid, id FROM {table} WHERE uuid <> ''"))
        .map_err(err)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(err)
}

/// True when a local tombstone still outvotes this incoming row (the
/// deletion happened at-or-after the row's last edit).
fn tombstone_wins(
    conn: &Connection,
    table: &str,
    uuid: &str,
    updated_at: &str,
) -> Result<bool, String> {
    let deleted_at: Option<String> = conn
        .query_row(
            "SELECT deleted_at FROM sync_tombstones WHERE table_name = ?1 AND uuid = ?2",
            params![table, uuid],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    Ok(deleted_at.is_some_and(|d| d.as_str() >= updated_at))
}

fn clear_tombstone(conn: &Connection, table: &str, uuid: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sync_tombstones WHERE table_name = ?1 AND uuid = ?2",
        params![table, uuid],
    )
    .map_err(err)?;
    Ok(())
}

/// Applies one incoming row with last-writer-wins semantics: insert when the
/// uuid is unknown, overwrite only when the incoming `updatedAt` is strictly
/// newer than the local row's. `extra` supplies FK ids resolved by the
/// caller. Returns true when a row was written.
fn apply_row(
    conn: &Connection,
    table: &str,
    key_col: &str,
    uuid: &str,
    row: &Json,
    cols: &[SqlCol],
    extra: &[(&str, SqlValue)],
    stats: &mut MergeStats,
) -> Result<bool, String> {
    let Some(obj) = row.as_object() else { return Ok(false) };
    let updated_at = jstr(row, "updatedAt").unwrap_or("");
    if updated_at.is_empty() {
        return Ok(false); // no timestamp → cannot order this row; ignore it
    }
    if tombstone_wins(conn, table, uuid, updated_at)? {
        return Ok(false);
    }
    // The row is alive again (or new): any stale tombstone must go, or a
    // future pull would delete it.
    clear_tombstone(conn, table, uuid)?;

    let mut names: Vec<&str> = vec![key_col];
    let mut vals: Vec<SqlValue> = vec![SqlValue::Text(uuid.to_string())];
    for (col, key) in cols {
        if *col == key_col {
            continue;
        }
        // Absent keys are omitted so the column's own default stands in —
        // an incoming row should never null out a NOT NULL column.
        let Some(v) = obj.get(*key) else { continue };
        names.push(col);
        vals.push(json_to_sql(v));
    }
    for (col, v) in extra {
        names.push(col);
        vals.push(v.clone());
    }

    let existing: Option<String> = conn
        .query_row(
            &format!("SELECT updated_at FROM {table} WHERE {key_col} = ?1"),
            params![uuid],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if existing.is_some() {
        // Local row exists: last writer wins. Equal timestamps keep local.
        if existing.unwrap().as_str() >= updated_at {
            return Ok(false);
        }
        let sets = names
            .iter()
            .map(|c| format!("{c} = ?"))
            .collect::<Vec<_>>()
            .join(", ");
        let n = names.len();
        conn.execute(
            &format!("UPDATE {table} SET {sets} WHERE {key_col} = ?{n1}", n1 = n + 1),
            params_from_iter(
                vals.into_iter()
                    .chain(std::iter::once(SqlValue::Text(uuid.to_string()))),
            ),
        )
        .map_err(err)?;
        stats.updated += 1;
    } else {
        let sql = format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            names.join(", "),
            vec!["?"; names.len()].join(", ")
        );
        conn.execute(&sql, params_from_iter(vals)).map_err(err)?;
        stats.inserted += 1;
    }
    Ok(true)
}

/// Merges an incoming v2 snapshot into the local database: union by uuid,
/// per-row last-writer-wins by `updated_at`, incoming tombstones applied
/// first (an edit newer than the deletion resurrects the row).
fn merge_snapshot(conn: &Connection, snapshot: &Json) -> Result<MergeStats, String> {
    let mut stats = MergeStats::default();
    let tx = conn.unchecked_transaction().map_err(err)?;

    // 1) Deletions first, so a snapshot carrying both a tombstone and the
    //    row it deleted does not resurrect the row.
    if let Some(tombs) = snapshot.get("tombstones").and_then(Json::as_array) {
        for t in tombs {
            let table = t.get("table").and_then(Json::as_str).unwrap_or("");
            let uuid = t.get("uuid").and_then(Json::as_str).unwrap_or("");
            let deleted_at = t.get("deletedAt").and_then(Json::as_str).unwrap_or("");
            if !tombstone_table_ok(table) || uuid.is_empty() || deleted_at.is_empty() {
                continue;
            }
            let local_updated: Option<String> = if table == "profile" {
                tx.query_row(
                    "SELECT updated_at FROM profile WHERE field_key = ?1",
                    params![uuid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?
            } else {
                tx.query_row(
                    &format!("SELECT updated_at FROM {table} WHERE uuid = ?1"),
                    params![uuid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?
            };
            if let Some(local_updated) = local_updated {
                if local_updated.as_str() > deleted_at {
                    // Edited after the deletion: the edit wins, tombstone drops.
                    clear_tombstone(&tx, table, uuid)?;
                    continue;
                }
                // Tombstone wins: remove the local row now.
                if table == "profile" {
                    stats.tombstoned += tx
                        .execute("DELETE FROM profile WHERE field_key = ?1", params![uuid])
                        .map_err(err)?;
                } else {
                    stats.tombstoned += tx
                        .execute(
                            &format!("DELETE FROM {table} WHERE uuid = ?1"),
                            params![uuid],
                        )
                        .map_err(err)?;
                }
            }
            // Remember the deletion locally (MAX on conflict) so this
            // device's next export carries it to everyone else.
            record_tombstones(&tx, table, &[uuid.to_string()]).map_err(err)?;
        }
    }

    // 2) Data rows, parents before children.
    for row in rows_of(snapshot, "resume_versions") {
        let Some(uuid) = jstr(row, "uuid") else { continue };
        apply_row(&tx, "resume_versions", "uuid", uuid, row, RESUME_COLS, &[], &mut stats)?;
    }
    for row in rows_of(snapshot, "prepared_answers") {
        let Some(uuid) = jstr(row, "uuid") else { continue };
        apply_row(&tx, "prepared_answers", "uuid", uuid, row, ANSWER_COLS, &[], &mut stats)?;
    }
    for row in rows_of(snapshot, "reference_contacts") {
        let Some(uuid) = jstr(row, "uuid") else { continue };
        apply_row(&tx, "reference_contacts", "uuid", uuid, row, REF_COLS, &[], &mut stats)?;
    }
    for row in rows_of(snapshot, "profile") {
        // profile has no uuid column: field_key is the stable identity.
        let Some(key) = jstr(row, "fieldKey") else { continue };
        apply_row(&tx, "profile", "field_key", key, row, PROFILE_COLS, &[], &mut stats)?;
    }

    let resume_ids = uuid_id_map(&tx, "resume_versions")?;
    for row in rows_of(snapshot, "applications") {
        let Some(uuid) = jstr(row, "uuid") else { continue };
        let resume_id = jstr(row, "resumeVersionUuid")
            .and_then(|u| resume_ids.get(u).copied());
        let extra = [(
            "resume_version_id",
            resume_id
                .map(SqlValue::Integer)
                .unwrap_or(SqlValue::Null),
        )];
        apply_row(&tx, "applications", "uuid", uuid, row, APP_COLS, &extra, &mut stats)?;
    }

    let app_ids = uuid_id_map(&tx, "applications")?;
    for row in rows_of(snapshot, "application_correspondence") {
        let Some(uuid) = jstr(row, "uuid") else { continue };
        // Children whose parent is missing cannot attach: skip them.
        let Some(app_uuid) = jstr(row, "applicationUuid") else { continue };
        let Some(app_id) = app_ids.get(app_uuid).copied() else {
            continue;
        };
        let extra = [("application_id", SqlValue::Integer(app_id))];
        apply_row(&tx, "application_correspondence", "uuid", uuid, row, CORR_COLS, &extra, &mut stats)?;
    }

    let corr_ids = uuid_id_map(&tx, "application_correspondence")?;
    for row in rows_of(snapshot, "application_events") {
        let Some(uuid) = jstr(row, "uuid") else { continue };
        let Some(app_uuid) = jstr(row, "applicationUuid") else { continue };
        let Some(app_id) = app_ids.get(app_uuid).copied() else {
            continue;
        };
        let corr_id = match jstr(row, "correspondenceUuid") {
            Some(corr_uuid) => corr_ids.get(corr_uuid).copied(),
            None => None,
        };
        let extra = [
            ("application_id", SqlValue::Integer(app_id)),
            (
                "correspondence_id",
                corr_id.map(SqlValue::Integer).unwrap_or(SqlValue::Null),
            ),
        ];
        apply_row(&tx, "application_events", "uuid", uuid, row, EVENT_COLS, &extra, &mut stats)?;
    }

    tx.commit().map_err(err)?;
    Ok(stats)
}

/// Detects a v2 snapshot (uuid-based, mergeable) vs the legacy v1 shape.
fn snapshot_is_v2(snapshot: &Json) -> bool {
    if snapshot.get("version").and_then(Json::as_i64) == Some(2) {
        return true;
    }
    snapshot
        .get("applications")
        .and_then(Json::as_array)
        .and_then(|a| a.first())
        .map(|row| jstr(row, "uuid").is_some())
        .unwrap_or(false)
}

// ---------- Dropbox API ----------

/// Exchanges the refresh token for a fresh access token (cheap, done per op).
async fn access_token(config: &SyncConfig) -> Result<String, String> {
    if config.refresh_token.is_empty() {
        return Err("Dropbox is not connected yet.".into());
    }
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", config.refresh_token.as_str()),
        ("client_id", config.app_key.as_str()),
    ];
    let resp = reqwest::Client::new()
        .post("https://api.dropbox.com/oauth2/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox rejected the saved connection ({body}). Reconnect from Settings."));
    }
    let json: Json = resp.json().await.map_err(|e| e.to_string())?;
    json.get("access_token")
        .and_then(Json::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Dropbox response had no token.".into())
}

fn dropbox_error(status: u16, body: &str) -> String {
    format!("Dropbox error {status}: {body}")
}

async fn dropbox_upload(token: &str, blob: &[u8]) -> Result<String, String> {
    let arg = json!({ "path": CLOUD_PATH, "mode": "overwrite", "mute": true }).to_string();
    let resp = reqwest::Client::new()
        .post("https://content.dropboxapi.com/2/files/upload")
        .bearer_auth(token)
        .header("Dropbox-API-Arg", arg)
        .header("Content-Type", "application/octet-stream")
        .body(blob.to_vec())
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(dropbox_error(status, &body));
    }
    let json: Json = serde_json::from_str(&body)
        .map_err(|e| format!("Unexpected Dropbox upload response: {e}"))?;
    Ok(json.get("rev").and_then(Json::as_str).unwrap_or("").to_string())
}

async fn dropbox_download(token: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let arg = json!({ "path": CLOUD_PATH }).to_string();
    let resp = reqwest::Client::new()
        .post("https://content.dropboxapi.com/2/files/download")
        .bearer_auth(token)
        .header("Dropbox-API-Arg", arg)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    if status == 409 {
        return Err("No sync file exists in Dropbox yet — push first.".into());
    }
    if status != 200 {
        let body = resp.text().await.unwrap_or_default();
        return Err(dropbox_error(status, &body));
    }
    let rev = headers
        .get("Dropbox-API-Result")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| serde_json::from_str::<Json>(s).ok())
        .and_then(|j| j.get("rev").and_then(Json::as_str).map(str::to_string));
    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {e}"))?;
    Ok((bytes.to_vec(), rev))
}

/// Public metadata info for conflict checks (rev + modified time).
async fn dropbox_metadata(token: &str) -> Result<Option<(String, String)>, String> {
    let resp = reqwest::Client::new()
        .post("https://api.dropboxapi.com/2/files/get_metadata")
        .bearer_auth(token)
        .json(&json!({ "path": CLOUD_PATH }))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 409 {
        return Ok(None); // no file yet
    }
    if status != 200 {
        return Err(dropbox_error(status, &body));
    }
    let json: Json = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let rev = json.get("rev").and_then(Json::as_str).unwrap_or("").to_string();
    let modified = json
        .get("client_modified")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();
    Ok(Some((rev, modified)))
}

// ---------- helpers ----------

fn lock_db_sync<'a>(
    state: &'a tauri::State<'_, DbState>,
) -> Result<std::sync::MutexGuard<'a, Connection>, String> {
    state.0.lock().map_err(|_| "Database is busy.".into())
}

// ---------- commands ----------

/// Non-secret view of the sync config for the Settings UI (and header dot).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub connected: bool,
    pub has_app_key: bool,
    pub encrypt: bool,
    pub auto_sync: bool,
    pub remember_passphrase: bool,
    pub last_sync_at: String,
    pub pending_pkce: bool,
    /// True when local data differs from what the cloud last received.
    pub dirty: bool,
}

#[tauri::command]
pub fn sync_get_info(app: tauri::AppHandle, db: tauri::State<'_, DbState>) -> Result<SyncInfo, String> {
    let config = load_config(&app)?;
    let connected = !config.refresh_token.is_empty();
    // Dirty check: hash the current local data and compare with the digest
    // remembered at the last push/pull. Only meaningful when connected.
    let dirty = if connected {
        let conn = lock_db_sync(&db)?;
        let digest = snapshot_digest(&export_snapshot(&conn)?);
        digest != config.last_pushed_digest
    } else {
        false
    };
    Ok(SyncInfo {
        connected,
        has_app_key: !config.app_key.is_empty(),
        encrypt: config.encrypt,
        auto_sync: config.auto_sync,
        remember_passphrase: config.remember_passphrase,
        last_sync_at: config.last_sync_at.clone(),
        pending_pkce: config.refresh_token.is_empty() && !config.pkce_verifier.is_empty(),
        dirty,
    })
}

/// Saves UI-editable sync settings (App key, E2E toggle, passphrase memory).
#[tauri::command]
pub fn sync_save_settings(
    app: tauri::AppHandle,
    app_key: Option<String>,
    encrypt: Option<bool>,
    auto_sync: Option<bool>,
    remember_passphrase: Option<bool>,
    passphrase: Option<String>,
) -> Result<(), String> {
    let mut config = load_config(&app)?;
    if let Some(k) = app_key {
        config.app_key = k.trim().to_string();
    }
    if let Some(e) = encrypt {
        config.encrypt = e;
    }
    if let Some(a) = auto_sync {
        config.auto_sync = a;
    }
    if let Some(r) = remember_passphrase {
        config.remember_passphrase = r;
        if !r {
            config.passphrase = String::new();
        }
    }
    if let Some(p) = passphrase {
        config.passphrase = if config.remember_passphrase { p } else { String::new() };
    }
    save_config(&app, &config)
}

/// Starts the Dropbox OAuth flow: builds a PKCE challenge, persists the
/// verifier, and returns the authorization URL (the opener plugin shows it).
#[tauri::command]
pub fn sync_start_connect(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<String, String> {
    let mut config = load_config(&app)?;
    if config.app_key.is_empty() {
        return Err("Enter your Dropbox app key first.".into());
    }
    // PKCE: verifier = 43+ URL-safe random chars; challenge = BASE64URL(SHA256(verifier)).
    let mut raw = [0u8; 32];
    chacha20poly1305::aead::rand_core::OsRng.fill_bytes(&mut raw);
    let verifier = URL_SAFE_NO_PAD.encode(raw);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    config.pkce_verifier = verifier.clone();
    save_config(&app, &config)?;
    *state.verifier.lock().map_err(|_| "Lock error".to_string())? = Some(verifier);

    let url = format!(
        "https://www.dropbox.com/oauth2/authorize?client_id={}&response_type=code&token_access_type=offline&code_challenge={challenge}&code_challenge_method=S256",
        urlencoded(&config.app_key)
    );
    // Show the Dropbox authorization page right away; the URL is also
    // returned so the UI can display it as a manual fallback.
    open_external(&app, &url)?;
    Ok(url)
}

/// Opens a URL with the OS default browser (opener plugin).
fn open_external(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Could not open the browser: {e}"))
}

fn urlencoded(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"~-._".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Completes the connect flow: exchanges the pasted code for a refresh token.
#[tauri::command]
pub async fn sync_complete_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SyncState>,
    code: String,
) -> Result<(), String> {
    let mut config = load_config(&app)?;
    let verifier = state
        .verifier
        .lock()
        .map_err(|_| "Lock error".to_string())?
        .clone()
        .or_else(|| {
            if config.pkce_verifier.is_empty() {
                None
            } else {
                Some(config.pkce_verifier.clone())
            }
        })
        .ok_or_else(|| "Click Connect again — no authorization is in progress.".to_string())?;
    if config.app_key.is_empty() {
        return Err("Enter your Dropbox app key first.".into());
    }
    let params = [
        ("code", code.trim()),
        ("grant_type", "authorization_code"),
        ("client_id", config.app_key.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    let resp = reqwest::Client::new()
        .post("https://api.dropbox.com/oauth2/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(dropbox_error(status, &body));
    }
    let json: Json = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let refresh = json
        .get("refresh_token")
        .and_then(Json::as_str)
        .ok_or("Dropbox did not return a refresh token — make sure the app requests offline access.")?
        .to_string();
    config.refresh_token = refresh;
    config.pkce_verifier = String::new();
    *state.verifier.lock().map_err(|_| "Lock error".to_string())? = None;
    save_config(&app, &config)?;
    Ok(())
}

/// Forgets the Dropbox connection entirely (keeps local settings).
#[tauri::command]
pub fn sync_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let mut config = load_config(&app)?;
    config.refresh_token = String::new();
    config.last_known_rev = String::new();
    config.pkce_verifier = String::new();
    save_config(&app, &config)
}

/// Core push: snapshot → (encrypt) → upload → remember digest/rev/time.
/// `pass_override` (from the UI) wins over the remembered passphrase.
/// Used by the command and by the auto-push on app exit.
pub(crate) async fn push_snapshot(
    app: &tauri::AppHandle,
    db: &tauri::State<'_, DbState>,
    pass_override: Option<&str>,
) -> Result<String, String> {
    let config = load_config(app)?;
    let pass = pass_override
        .map(str::to_string)
        .or_else(|| Some(config.passphrase.clone()).filter(|p| !p.is_empty()));

    // Snapshot + digest while holding the DB lock, then drop it before any await.
    let (snapshot, digest) = {
        let conn = lock_db_sync(db)?;
        let snap = export_snapshot(&conn)?;
        let d = snapshot_digest(&snap);
        (snap, d)
    };
    let encrypt = config.encrypt;
    if encrypt && pass.is_none() {
        return Err("Enter your sync passphrase (or enable 'remember').".into());
    }
    let blob = pack_blob(&snapshot, encrypt, pass.as_deref().unwrap_or(""))?;
    let token = access_token(&config).await?;
    let rev = dropbox_upload(&token, &blob).await?;

    let mut updated = config;
    updated.last_known_rev = rev;
    updated.last_pushed_digest = digest;
    updated.last_sync_at = now_iso();
    save_config(app, &updated)?;
    let n = snapshot
        .get("applications")
        .and_then(Json::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    Ok(format!(
        "Pushed {} applications ({} KB, {}).",
        n,
        blob.len() / 1024,
        if encrypt { "encrypted" } else { "not encrypted" }
    ))
}

/// Pushes a (possibly encrypted) snapshot of everything to Dropbox.
/// Conflicts with remote changes are surfaced via `sync_check_cloud`.
#[tauri::command]
pub async fn sync_push(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<String, String> {
    push_snapshot(
        &app,
        &db,
        passphrase.as_deref().filter(|p| !p.is_empty()),
    )
    .await
}

/// Downloads the cloud snapshot and applies it to the local database.
/// v2 snapshots are *merged* (union by uuid, last-writer-wins) with a safety
/// backup written first; legacy v1 snapshots still replace-all but only
/// into an empty local database (anything else risks data loss).
async fn pull_and_merge(
    app: &tauri::AppHandle,
    db: &tauri::State<'_, DbState>,
    pass_override: Option<&str>,
) -> Result<String, String> {
    let config = load_config(app)?;
    let pass = pass_override
        .map(str::to_string)
        .or_else(|| Some(config.passphrase.clone()).filter(|p| !p.is_empty()));

    let token = access_token(&config).await?;
    let (blob, rev) = dropbox_download(&token).await?;
    let snapshot = unpack_blob(&blob, pass.as_deref().unwrap_or(""))?;

    // Safety backup of the current local data (plain JSON, same shape).
    let result = {
        let conn = lock_db_sync(db)?;
        if let Ok(dir) = app.path().app_data_dir() {
            let backup = export_snapshot(&conn)?;
            let _ = std::fs::write(
                dir.join("pre-pull-backup.json"),
                serde_json::to_vec(&backup).unwrap_or_default(),
            );
        }
        if snapshot_is_v2(&snapshot) {
            let stats = merge_snapshot(&conn, &snapshot)?;
            let mut updated = config;
            if let Some(rev) = rev {
                updated.last_known_rev = rev;
            }
            // Digest of the *incoming* snapshot: the local data now also
            // carries our side of the merge, so the dot stays dirty until
            // the follow-up push in the same sync cycle.
            updated.last_pushed_digest = snapshot_digest(&snapshot);
            updated.last_sync_at = now_iso();
            save_config(app, &updated)?;
            Ok(format!(
                "Merged the cloud snapshot: {} added, {} updated, {} removed. A backup of your previous data is at pre-pull-backup.json.",
                stats.inserted, stats.updated, stats.tombstoned
            ))
        } else {
            // Legacy v1 blob: only safe into an empty local database.
            let apps: i64 = conn
                .query_row("SELECT COUNT(*) FROM applications", [], |r| r.get(0))
                .map_err(err)?;
            if apps > 0 {
                Err("This cloud file is from an older version. Push once from this device to upgrade it, then sync.".to_string())
            } else {
                let imported = import_snapshot(&conn, &snapshot)?;
                let mut updated = config;
                if let Some(rev) = rev {
                    updated.last_known_rev = rev;
                }
                updated.last_pushed_digest = snapshot_digest(&snapshot);
                updated.last_sync_at = now_iso();
                save_config(app, &updated)?;
                Ok(format!(
                    "Restored the cloud snapshot: {imported} rows imported. A backup of your previous data is at pre-pull-backup.json."
                ))
            }
        }
    };
    result
}

/// Downloads the cloud snapshot, decrypts it, and merges it into the local
/// data. A pre-pull backup of the current data is written next to the
/// database.
#[tauri::command]
pub async fn sync_pull(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<String, String> {
    pull_and_merge(
        &app,
        &db,
        passphrase.as_deref().filter(|p| !p.is_empty()),
    )
    .await
}

/// One "Sync now": pull-merge only when the cloud revision moved since our
/// last sync, then push the merged result. Also used by the auto-sync on
/// app exit, so both paths behave identically.
#[tauri::command]
pub async fn sync_cycle(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let config = load_config(&app)?;
    let mut messages: Vec<String> = Vec::new();

    let token = access_token(&config).await?;
    let meta = dropbox_metadata(&token).await?;
    match meta {
        // Cloud unchanged since our last sync: nothing to pull.
        Some((rev, _)) if rev == config.last_known_rev => {}
        // Cloud moved (or we never saw it): pull-merge first.
        Some(_) => {
            messages.push(
                pull_and_merge(
                    &app,
                    &db,
                    passphrase.as_deref().filter(|p| !p.is_empty()),
                )
                .await?,
            );
        }
        // No cloud file yet: the push below creates it.
        None => {}
    }
    messages.push(
        push_snapshot(&app, &db, passphrase.as_deref().filter(|p| !p.is_empty())).await?,
    );
    Ok(messages.join(" "))
}

/// Auto-sync on app close: runs the same pull-merge-then-push cycle as the
/// "Sync now" button if connected, auto-sync is on, and (with E2E) a
/// remembered passphrase exists. Runs synchronously on the exit path so the
/// upload finishes before the process dies; the result is appended to
/// `sync.log` and visible via the header dot next launch.
pub fn auto_push_on_exit(app: &tauri::AppHandle) {
    let outcome = tauri::async_runtime::block_on(async {
        let config = load_config(app)?;
        if !config.auto_sync || config.refresh_token.is_empty() {
            return Ok("auto-sync skipped (off or not connected)".to_string());
        }
        if config.encrypt && config.passphrase.trim().is_empty() {
            return Ok("auto-sync skipped: encrypted but no remembered passphrase".to_string());
        }
        let db = app.state::<DbState>();
        sync_cycle(app.clone(), db, None).await
    });
    let line = match outcome {
        Ok(msg) => format!("{} auto-sync OK: {msg}", now_iso()),
        Err(e) => format!("{} auto-sync FAILED: {e}", now_iso()),
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

/// Cloud state for the UI: whether a file exists, its revision, and whether
/// that revision is the one this device last pushed/pulled (no conflict).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub exists: bool,
    pub modified: String,
    pub rev_matches: bool,
    pub last_sync_at: String,
}

#[tauri::command]
pub async fn sync_check_cloud(app: tauri::AppHandle) -> Result<CloudStatus, String> {
    let config = load_config(&app)?;
    let token = access_token(&config).await?;
    let meta = dropbox_metadata(&token).await?;
    let (exists, modified, rev) = match meta {
        Some((rev, modified)) => (true, modified, Some(rev)),
        None => (false, String::new(), None),
    };
    let rev_matches = exists
        && rev
            .map(|r| r == config.last_known_rev)
            .unwrap_or(false);
    Ok(CloudStatus {
        exists,
        modified,
        rev_matches,
        last_sync_at: config.last_sync_at.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn blob_round_trip_encrypted() {
        let snapshot = json!({ "applications": [{ "id": 1, "company": "Test" }] });
        let blob = pack_blob(&snapshot, true, "correct horse").unwrap();
        // wrong passphrase must fail
        assert!(unpack_blob(&blob, "wrong").is_err());
        // right passphrase must restore the exact JSON
        let out = unpack_blob(&blob, "correct horse").unwrap();
        assert_eq!(out, snapshot);
    }

    #[test]
    fn blob_round_trip_plaintext() {
        let snapshot = json!({ "profile": [] });
        let blob = pack_blob(&snapshot, false, "").unwrap();
        let out = unpack_blob(&blob, "").unwrap();
        assert_eq!(out, snapshot);
    }

    #[test]
    fn digest_stable_across_exports() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO applications (company, role, status, created_at, updated_at)
             VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        // Two exports at different moments must hash identically (the
        // volatile exportedAt field is excluded from the digest).
        let d1 = snapshot_digest(&export_snapshot(&conn).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(10));
        let d2 = snapshot_digest(&export_snapshot(&conn).unwrap());
        assert_eq!(d1, d2);
        // Any data change must change the digest.
        conn.execute("UPDATE applications SET status = 'rejected'", []).unwrap();
        let d3 = snapshot_digest(&export_snapshot(&conn).unwrap());
        assert_ne!(d1, d3);
    }

    #[test]
    fn snapshot_export_merge_round_trip() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO applications (company, role, status, created_at, updated_at)
             VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let app_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO application_events (application_id, occurred_at, kind, note, created_at, updated_at)
             VALUES (?1, '2026-01-02', 'note', 'applied', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
            rusqlite::params![app_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profile (field_key, value, updated_at, sort_order) VALUES ('Email', 'a@b.c', '2026-01-01T00:00:00.000Z', 0)",
            [],
        )
        .unwrap();

        let snap = export_snapshot(&conn).unwrap();
        // wipe and merge everything back in
        for table in TABLES {
            conn.execute(&format!("DELETE FROM {table}"), []).unwrap();
        }
        let stats = merge_snapshot(&conn, &snap).unwrap();
        assert!(stats.inserted >= 3, "stats = {stats:?}");
        assert_eq!(stats.updated, 0);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM application_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let email: String = conn
            .query_row("SELECT value FROM profile WHERE field_key = 'Email'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(email, "a@b.c");
    }

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    /// Forces a known uuid on a row (migrate backfills random ones).
    fn set_uuid(conn: &Connection, table: &str, id: i64, uuid: &str) {
        conn.execute(
            &format!("UPDATE {table} SET uuid = ?1 WHERE id = ?2"),
            rusqlite::params![uuid, id],
        )
        .unwrap();
    }

    #[test]
    fn snapshot_version_detection() {
        let v1 = json!({ "schemaVersion": 1, "applications": [{ "id": 1, "company": "A" }] });
        assert!(!snapshot_is_v2(&v1));
        let v2 = json!({ "version": 2, "applications": [] });
        assert!(snapshot_is_v2(&v2));
        let v2_no_flag = json!({ "applications": [{ "uuid": "x", "updatedAt": "2026-01-01" }] });
        assert!(snapshot_is_v2(&v2_no_flag));
    }

    /// Legacy v1 snapshots (SQL-named keys) still import wholesale.
    #[test]
    fn legacy_v1_import_still_works() {
        let conn = fresh_db();
        let v1 = json!({
            "applications": [{
                "company": "Acme", "role": "Dev", "status": "applied",
                "created_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }],
            "profile": [{
                "field_key": "Email", "value": "a@b.c",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }],
        });
        let imported = import_snapshot(&conn, &v1).unwrap();
        assert_eq!(imported, 2);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM applications", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn merge_inserts_and_maps_fks() {
        let donor = fresh_db();
        donor
            .execute(
                "INSERT INTO resume_versions (name, created_at, updated_at)
                 VALUES ('Res', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
        let resume_id = donor.last_insert_rowid();
        set_uuid(&donor, "resume_versions", resume_id, "resume-uuid");
        donor
            .execute(
                "INSERT INTO applications (company, role, status, resume_version_id, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'applied', ?1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
                rusqlite::params![resume_id],
            )
            .unwrap();
        let app_id = donor.last_insert_rowid();
        set_uuid(&donor, "applications", app_id, "app-uuid");
        donor
            .execute(
                "INSERT INTO application_events (application_id, occurred_at, kind, note, created_at, updated_at)
                 VALUES (?1, '2026-01-01', 'applied', 'applied online', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                rusqlite::params![app_id],
            )
            .unwrap();
        set_uuid(&donor, "application_events", donor.last_insert_rowid(), "event-uuid");
        donor
            .execute(
                "INSERT INTO application_correspondence (application_id, kind, occurred_at, body, created_at, updated_at)
                 VALUES (?1, 'email', '2026-01-03', 'hello', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')",
                rusqlite::params![app_id],
            )
            .unwrap();
        set_uuid(&donor, "application_correspondence", donor.last_insert_rowid(), "corr-uuid");

        let snap = export_snapshot(&donor).unwrap();
        let target = fresh_db();
        let stats = merge_snapshot(&target, &snap).unwrap();
        assert_eq!(
            stats,
            MergeStats { inserted: 4, updated: 0, tombstoned: 0 }
        );

        // Local integer ids were assigned fresh, but every link survived.
        let app_id: i64 = target
            .query_row("SELECT id FROM applications WHERE uuid = 'app-uuid'", [], |r| r.get(0))
            .unwrap();
        let resume_id: i64 = target
            .query_row("SELECT id FROM resume_versions WHERE uuid = 'resume-uuid'", [], |r| r.get(0))
            .unwrap();
        let linked: Option<i64> = target
            .query_row(
                "SELECT resume_version_id FROM applications WHERE id = ?1",
                [app_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, Some(resume_id));
        let ev_app: i64 = target
            .query_row("SELECT application_id FROM application_events WHERE uuid = 'event-uuid'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ev_app, app_id);
        let corr_app: i64 = target
            .query_row(
                "SELECT application_id FROM application_correspondence WHERE uuid = 'corr-uuid'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(corr_app, app_id);
    }

    #[test]
    fn merge_last_writer_wins() {
        let donor = fresh_db();
        donor
            .execute(
                "INSERT INTO applications (company, role, status, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'rejected', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z')",
                [],
            )
            .unwrap();
        set_uuid(&donor, "applications", donor.last_insert_rowid(), "app-uuid");
        let snap = export_snapshot(&donor).unwrap();

        // Local row edited EARLIER: the incoming (newer) edit wins.
        let target = fresh_db();
        target
            .execute(
                "INSERT INTO applications (company, role, status, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')",
                [],
            )
            .unwrap();
        set_uuid(&target, "applications", target.last_insert_rowid(), "app-uuid");
        let stats = merge_snapshot(&target, &snap).unwrap();
        assert_eq!(stats.updated, 1);
        assert_eq!(stats.inserted, 0);
        let status: String = target
            .query_row("SELECT status FROM applications WHERE uuid = 'app-uuid'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "rejected");

        // Local row edited LATER: the local edit survives untouched.
        let target = fresh_db();
        target
            .execute(
                "INSERT INTO applications (company, role, status, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'offer', '2026-01-01T00:00:00.000Z', '2026-01-09T00:00:00.000Z')",
                [],
            )
            .unwrap();
        set_uuid(&target, "applications", target.last_insert_rowid(), "app-uuid");
        let stats = merge_snapshot(&target, &snap).unwrap();
        assert_eq!(stats.updated, 0);
        let status: String = target
            .query_row("SELECT status FROM applications WHERE uuid = 'app-uuid'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "offer");
    }

    #[test]
    fn tombstone_deletes_and_propagates() {
        let donor = fresh_db();
        donor
            .execute(
                "INSERT INTO applications (company, role, status, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
                [],
            )
            .unwrap();
        set_uuid(&donor, "applications", donor.last_insert_rowid(), "app-uuid");
        record_tombstones(&donor, "applications", &["app-uuid".to_string()]).unwrap();
        let snap = export_snapshot(&donor).unwrap();
        // The row and its tombstone both travel in the snapshot.
        assert_eq!(rows_of(&snap, "applications").len(), 1);
        assert_eq!(rows_of(&snap, "tombstones").len(), 1);

        // Target has the same row, last edited before the deletion.
        let target = fresh_db();
        target
            .execute(
                "INSERT INTO applications (company, role, status, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
                [],
            )
            .unwrap();
        set_uuid(&target, "applications", target.last_insert_rowid(), "app-uuid");
        let stats = merge_snapshot(&target, &snap).unwrap();
        assert_eq!(stats.tombstoned, 1);
        let n: i64 = target
            .query_row("SELECT COUNT(*) FROM applications", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);

        // The deletion is remembered locally, so the next export carries it.
        let out = export_snapshot(&target).unwrap();
        assert_eq!(rows_of(&out, "tombstones").len(), 1);

        // Re-merging the same snapshot must not resurrect the row.
        let stats2 = merge_snapshot(&target, &snap).unwrap();
        assert_eq!(stats2.inserted, 0);
        assert_eq!(stats2.tombstoned, 0);
    }

    #[test]
    fn tombstone_loses_to_later_edit() {
        // Deletion happened Jan 3; the row was edited again Jan 4.
        let snap = json!({
            "version": 2,
            "applications": [{
                "uuid": "app-uuid",
                "company": "Acme", "role": "Dev", "status": "offer",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-05T00:00:00.000Z"
            }],
            "tombstones": [{
                "table": "applications", "uuid": "app-uuid",
                "deletedAt": "2026-01-03T00:00:00.000Z"
            }]
        });
        let target = fresh_db();
        target
            .execute(
                "INSERT INTO applications (company, role, status, created_at, updated_at)
                 VALUES ('Acme', 'Dev', 'applied', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z')",
                [],
            )
            .unwrap();
        set_uuid(&target, "applications", target.last_insert_rowid(), "app-uuid");

        let stats = merge_snapshot(&target, &snap).unwrap();
        // The row survives (edit after delete) and takes the newer content.
        assert_eq!(stats.tombstoned, 0);
        assert_eq!(stats.updated, 1);
        let n: i64 = target
            .query_row("SELECT COUNT(*) FROM applications", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let status: String = target
            .query_row("SELECT status FROM applications WHERE uuid = 'app-uuid'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "offer");
        // The outvoted tombstone is gone, so no future pull deletes the row.
        let tombs: i64 = target
            .query_row("SELECT COUNT(*) FROM sync_tombstones", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tombs, 0);
    }
}
