export const DEFAULT_TIMELINE_FILTERS = [
  "file_change",
  "user_message",
  "agent_message",
  "shell_command",
] as const;

const TIMELINE_FILTER_KEYS = new Set([
  ...DEFAULT_TIMELINE_FILTERS,
  "reasoning",
  "tool_output",
]);
const STORAGE_PREFIX = "agent-vis:desktop:timeline-filters:";

export interface TimelineFilterPreferences {
  activeFilters: Set<string>;
  showTokenUsage: boolean;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultTimelineFilterPreferences(): TimelineFilterPreferences {
  return {
    activeFilters: new Set(DEFAULT_TIMELINE_FILTERS),
    showTokenUsage: false,
  };
}

export function loadTimelineFilterPreferences(
  sessionKey: string,
  storage: PreferenceStorage = window.localStorage,
): TimelineFilterPreferences {
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${sessionKey}`);
    if (!raw) return defaultTimelineFilterPreferences();

    const parsed = JSON.parse(raw) as {
      activeFilters?: unknown;
      showTokenUsage?: unknown;
    };
    if (!Array.isArray(parsed.activeFilters)) return defaultTimelineFilterPreferences();

    return {
      activeFilters: new Set(
        parsed.activeFilters.filter(
          (filter): filter is string => typeof filter === "string" && TIMELINE_FILTER_KEYS.has(filter),
        ),
      ),
      showTokenUsage: parsed.showTokenUsage === true,
    };
  } catch {
    return defaultTimelineFilterPreferences();
  }
}

export function saveTimelineFilterPreferences(
  sessionKey: string,
  preferences: TimelineFilterPreferences,
  storage: PreferenceStorage = window.localStorage,
): void {
  try {
    storage.setItem(`${STORAGE_PREFIX}${sessionKey}`, JSON.stringify({
      activeFilters: [...preferences.activeFilters],
      showTokenUsage: preferences.showTokenUsage,
    }));
  } catch {
    // Storage can be unavailable in hardened webviews; the in-memory selection still works.
  }
}
