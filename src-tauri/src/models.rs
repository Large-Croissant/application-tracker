use serde::{Deserialize, Serialize};

/// One job application. Field names serialize to camelCase for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub id: i64,
    pub company: String,
    pub role: String,
    pub status: String,
    pub source: String,
    pub posting_url: String,
    pub location: String,
    pub work_mode: String,
    /// Compensation amount as a number (sort/format/sync friendly).
    pub salary_amount: Option<f64>,
    /// Optional upper bound of a pay range.
    pub salary_amount_max: Option<f64>,
    /// ISO currency code, default USD.
    pub salary_currency: String,
    /// Empty (not listed), or: yearly | monthly | hourly | contract | other
    pub salary_period: String,
    pub contact_name: String,
    pub contact_email: String,
    pub notes: String,
    /// Full job posting text so you can re-read what you applied to.
    pub posting_text: String,
    pub applied_at: Option<String>,
    /// Date to follow up on this application (reminder logic comes later).
    pub next_followup_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload sent when creating or updating an application.
/// Moving/editing in the UI always sends the full record, so both use one struct.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInput {
    pub company: String,
    pub role: String,
    pub status: String,
    pub source: String,
    pub posting_url: String,
    pub location: String,
    pub work_mode: String,
    pub salary_amount: Option<f64>,
    /// Optional upper bound of a pay range.
    pub salary_amount_max: Option<f64>,
    pub salary_currency: String,
    pub salary_period: String,
    pub contact_name: String,
    pub contact_email: String,
    pub notes: String,
    pub posting_text: String,
    pub applied_at: Option<String>,
    pub next_followup_at: Option<String>,
}

/// One timeline entry in an application's history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationEvent {
    pub id: i64,
    pub application_id: i64,
    /// Local date `YYYY-MM-DD`, or datetime `YYYY-MM-DDTHH:MM` with a time kept.
    pub occurred_at: String,
    /// note | call | interview | offer | decision | status_change | email | meeting
    pub kind: String,
    pub note: String,
    /// Set when this entry is the timeline record of a stored correspondence item.
    pub correspondence_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for creating or updating a timeline event.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub occurred_at: Option<String>,
    pub kind: String,
    pub note: String,
}

/// Timeline event prebuilt by an importer (e.g. Flosa import).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEventInput {
    pub occurred_at: String,
    pub kind: String,
    pub note: String,
}

/// One application plus its prebuilt timeline, from an import batch.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApplicationInput {
    #[serde(flatten)]
    pub app: ApplicationInput,
    pub events: Vec<ImportEventInput>,
}

/// A whole-file import batch: everything lands in one transaction.
/// When `replace` is set, applications imported earlier (source tag
/// "Flosa import") are removed in the same transaction first.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub applications: Vec<ImportApplicationInput>,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub events: usize,
    pub replaced: usize,
}

/// One touch with the company: an email, a call, or a meeting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCorrespondence {
    pub id: i64,
    pub application_id: i64,
    /// email | call | meeting
    pub kind: String,
    /// Local date `YYYY-MM-DD`, or datetime `YYYY-MM-DDTHH:MM` with a time kept.
    pub occurred_at: String,
    /// Meetings only: virtual | in_person
    pub meeting_mode: Option<String>,
    /// Email body, call summary, or meeting notes.
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for creating or updating a correspondence item.
/// `follow_up_status` optionally bumps the application's status in the same action.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrespondenceInput {
    /// Optional for compatibility; defaults to "email".
    pub kind: Option<String>,
    pub occurred_at: Option<String>,
    pub meeting_mode: Option<String>,
    pub body: String,
    pub follow_up_status: Option<String>,
}

// ---------- Vault ----------

/// One quick-paste profile field (arbitrary key/value row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileField {
    /// The field label itself is the key (e.g. "Full name").
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

/// One reference contact for application forms.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceContact {
    pub id: i64,
    pub name: String,
    pub relationship: String,
    pub title: String,
    pub company: String,
    pub email: String,
    pub phone: String,
    pub linkedin: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for creating or updating a reference contact.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInput {
    pub name: String,
    pub relationship: String,
    pub title: String,
    pub company: String,
    pub email: String,
    pub phone: String,
    pub linkedin: String,
    pub notes: String,
}

/// One prepared interview/application answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAnswer {
    pub id: i64,
    pub title: String,
    /// application text often asks for a pasted version
    pub body: String,
    pub category: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for creating or updating a prepared answer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerInput {
    pub title: String,
    pub body: String,
    pub category: String,
}

/// One named resume version with its (paste-friendly) text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeVersion {
    pub id: i64,
    pub name: String,
    pub file_name: String,
    pub notes: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for creating or updating a resume version.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeInput {
    pub name: String,
    pub file_name: String,
    pub notes: String,
    pub content: String,
}
