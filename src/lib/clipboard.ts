import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Copies text to the system clipboard with feedback for the calling UI.
 * Returns true on success so callers can flash "Copied!" states. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}
