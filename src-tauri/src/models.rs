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
    /// ISO currency code, default USD.
    pub salary_currency: String,
    /// Empty (not listed), or: yearly | monthly | hourly | contract | other
    pub salary_period: String,
    pub contact_name: String,
    pub contact_email: String,
    pub notes: String,
    pub applied_at: Option<String>,
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
    pub salary_currency: String,
    pub salary_period: String,
    pub contact_name: String,
    pub contact_email: String,
    pub notes: String,
    pub applied_at: Option<String>,
}
