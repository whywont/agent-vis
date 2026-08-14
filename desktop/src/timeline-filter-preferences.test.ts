import { describe, expect, it } from "vitest";
import {
  loadTimelineFilterPreferences,
  saveTimelineFilterPreferences,
} from "./timeline-filter-preferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("timeline filter preferences", () => {
  it("restores each session's last filter selection", () => {
    const storage = memoryStorage();
    saveTimelineFilterPreferences("session-a", {
      activeFilters: new Set(["shell_command"]),
      showTokenUsage: true,
    }, storage);
    saveTimelineFilterPreferences("session-b", {
      activeFilters: new Set(["file_change", "agent_message"]),
      showTokenUsage: false,
    }, storage);

    expect([...loadTimelineFilterPreferences("session-a", storage).activeFilters]).toEqual(["shell_command"]);
    expect(loadTimelineFilterPreferences("session-a", storage).showTokenUsage).toBe(true);
    expect([...loadTimelineFilterPreferences("session-b", storage).activeFilters]).toEqual([
      "file_change",
      "agent_message",
    ]);
  });

  it("preserves a session with no event types selected", () => {
    const storage = memoryStorage();
    saveTimelineFilterPreferences("session-a", {
      activeFilters: new Set(),
      showTokenUsage: false,
    }, storage);

    expect(loadTimelineFilterPreferences("session-a", storage).activeFilters.size).toBe(0);
  });

  it("uses defaults when the saved preference is invalid", () => {
    const storage = memoryStorage();
    storage.setItem("agent-vis:desktop:timeline-filters:session-a", "not-json");

    expect([...loadTimelineFilterPreferences("session-a", storage).activeFilters]).toEqual([
      "file_change",
      "user_message",
      "agent_message",
      "shell_command",
      "tool_call",
    ]);
  });

  it("enables tool calls when migrating preferences saved before that filter existed", () => {
    const storage = memoryStorage();
    storage.setItem("agent-vis:desktop:timeline-filters:session-a", JSON.stringify({
      activeFilters: ["agent_message"],
      showTokenUsage: false,
    }));

    expect([...loadTimelineFilterPreferences("session-a", storage).activeFilters]).toEqual([
      "agent_message",
      "tool_call",
    ]);
  });
});
