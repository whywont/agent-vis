const PINNED_SESSIONS_KEY = "agent-vis-pinned";

interface PinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPinnedSessions(storage: PinStorage = window.localStorage): Set<string> {
  try {
    const raw = storage.getItem(PINNED_SESSIONS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function savePinnedSessions(
  pinned: Set<string>,
  storage: PinStorage = window.localStorage,
): void {
  try {
    storage.setItem(PINNED_SESSIONS_KEY, JSON.stringify([...pinned]));
  } catch {
    // Pinning still works for the current run if persistent storage is unavailable.
  }
}
