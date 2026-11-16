import { invoke } from "@tauri-apps/api/core";
import type {
  Application,
  ApplicationCorrespondence,
  ApplicationEvent,
  ApplicationInput,
  AnswerInput,
  CorrespondenceInput,
  EventInput,
  PreparedAnswer,
  ProfileField,
  ReferenceContact,
  ReferenceInput,
  ResumeInput,
  ResumeVersion,
} from "../types";

/** Typed wrappers around the Tauri commands. */

export function listApplications(): Promise<Application[]> {
  return invoke("list_applications");
}

export function createApplication(input: ApplicationInput): Promise<Application> {
  return invoke("create_application", { input });
}

export function updateApplication(
  id: number,
  input: ApplicationInput,
): Promise<Application> {
  return invoke("update_application", { id, input });
}

export function deleteApplication(id: number): Promise<boolean> {
  return invoke("delete_application", { id });
}

/** Deletes several applications at once (cascade removes their timelines). */
export function deleteApplications(ids: number[]): Promise<number> {
  return invoke("delete_applications", { ids });
}

/** Builds a full ApplicationInput from an existing Application, so fields
 * other than the one being changed pass through untouched (e.g. inline
 * status changes in the detail drawer). */
export function applicationToInput(app: Application): ApplicationInput {
  return {
    company: app.company,
    role: app.role,
    status: app.status,
    source: app.source,
    postingUrl: app.postingUrl,
    location: app.location,
    workMode: app.workMode,
    salaryAmount: app.salaryAmount,
    salaryAmountMax: app.salaryAmountMax,
    salaryCurrency: app.salaryCurrency,
    salaryPeriod: app.salaryPeriod,
    contactName: app.contactName,
    contactEmail: app.contactEmail,
    notes: app.notes,
    postingText: app.postingText,
    appliedAt: app.appliedAt,
    nextFollowupAt: app.nextFollowupAt,
  };
}

export function listEvents(applicationId: number): Promise<ApplicationEvent[]> {
  return invoke("list_events", { applicationId });
}

/** Every timeline event across all applications (Insights / flow view). */
export function listAllEvents(): Promise<ApplicationEvent[]> {
  return invoke("list_all_events");
}

/** Creates a batch of "Sample · ..." applications with full histories. */
export function seedSampleData(): Promise<number> {
  return invoke("seed_sample_data");
}

/** Creates a batch of applications with prebuilt timeline events (Flosa import).
 * With `replace`, rows imported earlier are removed in the same transaction. */
export function importApplications(
  applications: unknown[],
  replace: boolean,
): Promise<{ imported: number; events: number; replaced: number }> {
  return invoke("import_applications", { batch: { applications, replace } });
}

/** Removes applications imported earlier from Flosa (matched by source tag). */
export function deleteImportedFlosa(): Promise<number> {
  return invoke("delete_imported_flosa");
}

/** Removes the sample applications again (matched by their prefix). */
export function deleteSampleData(): Promise<number> {
  return invoke("delete_sample_data");
}

export function addEvent(
  applicationId: number,
  input: EventInput,
): Promise<ApplicationEvent> {
  return invoke("add_event", { applicationId, input });
}

export function updateEvent(
  id: number,
  input: EventInput,
): Promise<ApplicationEvent> {
  return invoke("update_event", { id, input });
}

export function deleteEvent(id: number): Promise<boolean> {
  return invoke("delete_event", { id });
}

export function listCorrespondence(
  applicationId: number,
): Promise<ApplicationCorrespondence[]> {
  return invoke("list_correspondence", { applicationId });
}

export function addCorrespondence(
  applicationId: number,
  input: CorrespondenceInput,
): Promise<ApplicationCorrespondence> {
  return invoke("add_correspondence", { applicationId, input });
}

export function updateCorrespondence(
  id: number,
  input: CorrespondenceInput,
): Promise<ApplicationCorrespondence> {
  return invoke("update_correspondence", { id, input });
}

export function deleteCorrespondence(id: number): Promise<boolean> {
  return invoke("delete_correspondence", { id });
}

// ---------- Vault ----------

/** Upserts a profile field; an empty value deletes the row. */
export function setProfile(key: string, value: string): Promise<ProfileField> {
  return invoke("set_profile", { key, value });
}

export function listProfile(): Promise<ProfileField[]> {
  return invoke("list_profile");
}

/** Saves the display order of profile fields (full ordered key list). */
export function reorderProfile(keys: string[]): Promise<void> {
  return invoke("reorder_profile", { keys });
}

// ---------- Cloud sync (Dropbox) ----------

export interface SyncInfo {
  connected: boolean;
  hasAppKey: boolean;
  encrypt: boolean;
  autoSync: boolean;
  rememberPassphrase: boolean;
  lastSyncAt: string;
  pendingPkce: boolean;
  /** True when local data differs from what the cloud last received. */
  dirty: boolean;
}

export interface CloudStatus {
  exists: boolean;
  modified: string;
  revMatches: boolean;
  lastSyncAt: string;
}

export function syncGetInfo(): Promise<SyncInfo> {
  return invoke("sync_get_info");
}

export function syncSaveSettings(opts: {
  appKey?: string;
  encrypt?: boolean;
  autoSync?: boolean;
  rememberPassphrase?: boolean;
  passphrase?: string;
}): Promise<void> {
  return invoke("sync_save_settings", opts);
}

/** Starts the OAuth flow; opens Dropbox in the browser, returns the URL. */
export function syncStartConnect(): Promise<string> {
  return invoke("sync_start_connect");
}

export function syncCompleteConnect(code: string): Promise<void> {
  return invoke("sync_complete_connect", { code });
}

export function syncDisconnect(): Promise<void> {
  return invoke("sync_disconnect");
}

export function syncPush(passphrase: string | null): Promise<string> {
  return invoke("sync_push", { passphrase });
}

export function syncPull(passphrase: string | null): Promise<string> {
  return invoke("sync_pull", { passphrase });
}

export function syncCheckCloud(): Promise<CloudStatus> {
  return invoke("sync_check_cloud");
}

// ---------- backups & export ----------

export interface BackupEntry {
  name: string;
  sizeBytes: number;
  modified: string;
}

export function backupList(): Promise<BackupEntry[]> {
  return invoke("backup_list");
}

/** Returns the backup file path. */
export function backupNow(): Promise<string> {
  return invoke("backup_now");
}

/** How many days of backup files are kept. */
export function backupGetDays(): Promise<number> {
  return invoke("backup_get_days");
}

/** Sets the retention (clamped server-side to 1–365); returns the applied value. */
export function backupSetDays(days: number): Promise<number> {
  return invoke("backup_set_days", { days });
}

export function revealBackupFolder(): Promise<void> {
  return invoke("reveal_backup_folder");
}

/** Returns the CSV file path (it is also revealed in Explorer), or null when
 * the save dialog was cancelled. */
export function exportCsv(): Promise<string | null> {
  return invoke("export_csv");
}

export function listReferences(): Promise<ReferenceContact[]> {
  return invoke("list_references");
}

export function addReference(input: ReferenceInput): Promise<ReferenceContact> {
  return invoke("add_reference", { input });
}

export function updateReference(
  id: number,
  input: ReferenceInput,
): Promise<ReferenceContact> {
  return invoke("update_reference", { id, input });
}

export function deleteReference(id: number): Promise<boolean> {
  return invoke("delete_reference", { id });
}

export function listPreparedAnswers(): Promise<PreparedAnswer[]> {
  return invoke("list_prepared_answers");
}

export function addPreparedAnswer(input: AnswerInput): Promise<PreparedAnswer> {
  return invoke("add_prepared_answer", { input });
}

export function updatePreparedAnswer(
  id: number,
  input: AnswerInput,
): Promise<PreparedAnswer> {
  return invoke("update_prepared_answer", { id, input });
}

export function deletePreparedAnswer(id: number): Promise<boolean> {
  return invoke("delete_prepared_answer", { id });
}

export function listResumes(): Promise<ResumeVersion[]> {
  return invoke("list_resumes");
}

export function addResume(input: ResumeInput): Promise<ResumeVersion> {
  return invoke("add_resume", { input });
}

export function updateResume(id: number, input: ResumeInput): Promise<ResumeVersion> {
  return invoke("update_resume", { id, input });
}

export function deleteResume(id: number): Promise<boolean> {
  return invoke("delete_resume", { id });
}
