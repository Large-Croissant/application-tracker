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
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::db::{now_iso, DbState};

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
struct SyncConfig {
    app_key: String,
    refresh_token: String,
    /// End-to-end encryption on by default.
    encrypt: bool,
    remember_passphrase: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    passphrase: String,
    /// Dropbox revision seen at the last push/pull (conflict detection).
    last_known_rev: String,
    last_sync_at: String,
    /// PKCE verifier between "Connect" and "paste the code".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pkce_verifier: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create data directory: {e}"))?;
    Ok(dir.join("sync.json"))
}

fn load_config(app: &tauri::AppHandle) -> Result<SyncConfig, String> {
    let path = config_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Corrupt sync config: {e}")),
        Err(_) => Ok(SyncConfig::default()),
    }
}

fn save_config(app: &tauri::AppHandle, config: &SyncConfig) -> Result<(), String> {
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

// ---------- snapshot export / import ----------

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

/// Exports every table as an array of column→value objects.
fn export_snapshot(conn: &Connection) -> Result<Json, String> {
    let mut root = Map::new();
    root.insert("app".into(), json!("jobtracker"));
    root.insert("schemaVersion".into(), json!(1));
    root.insert("exportedAt".into(), json!(now_iso()));
    for table in TABLES {
        let cols = column_names(conn, table)?;
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table}"))
            .map_err(err)?;
        let mut rows_out: Vec<Json> = Vec::new();
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(row) = rows.next().map_err(err)? {
            let mut obj = Map::new();
            for (i, col) in cols.iter().enumerate() {
                let v: SqlValue = row.get(i).map_err(err)?;
                obj.insert(
                    col.clone(),
                    match v {
                        SqlValue::Null => Json::Null,
                        SqlValue::Integer(n) => json!(n),
                        SqlValue::Real(f) => json!(f),
                        SqlValue::Text(s) => json!(s),
                        SqlValue::Blob(b) => json!(STANDARD.encode(b)),
                    },
                );
            }
            rows_out.push(Json::Object(obj));
        }
        root.insert(table.to_string(), json!(rows_out));
    }
    Ok(Json::Object(root))
}

/// Replaces the local database with the snapshot in one transaction.
/// FK checks are deferred so table order can't break the import.
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

/// Non-secret view of the sync config for the Settings UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub connected: bool,
    pub has_app_key: bool,
    pub encrypt: bool,
    pub remember_passphrase: bool,
    pub last_sync_at: String,
    pub pending_pkce: bool,
}

#[tauri::command]
pub fn sync_get_info(app: tauri::AppHandle) -> Result<SyncInfo, String> {
    let config = load_config(&app)?;
    let pending = config.refresh_token.is_empty() && !config.pkce_verifier.is_empty();
    Ok(SyncInfo {
        connected: !config.refresh_token.is_empty(),
        has_app_key: !config.app_key.is_empty(),
        encrypt: config.encrypt,
        remember_passphrase: config.remember_passphrase,
        last_sync_at: config.last_sync_at.clone(),
        pending_pkce: pending,
    })
}

/// Saves UI-editable sync settings (App key, E2E toggle, passphrase memory).
#[tauri::command]
pub fn sync_save_settings(
    app: tauri::AppHandle,
    app_key: Option<String>,
    encrypt: Option<bool>,
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

/// Pushes a (possibly encrypted) snapshot of everything to Dropbox.
/// Returns a human summary; conflicts with remote changes are surfaced
/// in `sync_status` before this is pressed.
#[tauri::command]
pub async fn sync_push(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let config = load_config(&app)?;
    let pass = passphrase
        .or(Some(config.passphrase.clone()))
        .filter(|p| !p.is_empty());

    // Snapshot while holding the DB lock, then drop it before any await.
    let snapshot = {
        let conn = lock_db_sync(&db)?;
        export_snapshot(&conn)?
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
    updated.last_sync_at = now_iso();
    save_config(&app, &updated)?;
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

/// Downloads the cloud snapshot, decrypts it, and replaces the local data.
/// A pre-pull backup of the current data is written next to the database.
#[tauri::command]
pub async fn sync_pull(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let config = load_config(&app)?;
    let pass = passphrase
        .or(Some(config.passphrase.clone()))
        .filter(|p| !p.is_empty());

    let token = access_token(&config).await?;
    let (blob, rev) = dropbox_download(&token).await?;
    let snapshot = unpack_blob(&blob, pass.as_deref().unwrap_or(""))?;

    // Safety backup of the current local data (plain JSON, same shape).
    {
        let conn = lock_db_sync(&db)?;
        let backup = export_snapshot(&conn)?;
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::write(dir.join("pre-pull-backup.json"), serde_json::to_vec(&backup).unwrap_or_default());
        }
        let imported = import_snapshot(&conn, &snapshot)?;
        drop(conn);
        let mut updated = config;
        if let Some(rev) = rev {
            updated.last_known_rev = rev;
        }
        updated.last_sync_at = now_iso();
        save_config(&app, &updated)?;
        Ok(format!(
            "Pulled and applied the cloud snapshot: {imported} rows restored. A backup of your previous data is at pre-pull-backup.json."
        ))
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
    fn snapshot_export_import() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
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
        // wipe and re-import
        for table in TABLES {
            conn.execute(&format!("DELETE FROM {table}"), []).unwrap();
        }
        let imported = import_snapshot(&conn, &snap).unwrap();
        assert!(imported >= 3);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM application_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let email: String = conn
            .query_row("SELECT value FROM profile WHERE field_key = 'Email'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(email, "a@b.c");
    }
}
