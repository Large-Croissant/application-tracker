import { invoke } from "@tauri-apps/api/core";
import type {
  Application,
  ApplicationCorrespondence,
  ApplicationEvent,
  ApplicationInput,
  CorrespondenceInput,
  EventInput,
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
