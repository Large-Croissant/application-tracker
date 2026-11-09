import { invoke } from "@tauri-apps/api/core";
import type { Application, ApplicationInput } from "../types";

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
