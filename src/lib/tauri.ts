/**
 * Detect if running inside Tauri app container.
 * Tauri apps have a window title bar, so we don't need to show a title in the page.
 */
export function isRunningInTauri(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const w = window as any;
    // Check multiple Tauri indicators
    // 1. __TAURI__ namespace (v1 & v2)
    if (w.__TAURI__ !== undefined) return true;
    // 2. __TAURI_INTERNALS__ (v2)
    if (w.__TAURI_INTERNALS__ !== undefined) return true;
    // 3. Check user agent string (Tauri apps include "Tauri" in user agent)
    if (typeof navigator !== "undefined" && navigator.userAgent.includes("Tauri")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
