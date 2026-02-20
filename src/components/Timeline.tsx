"use client";

import type { AppEvent } from "@/lib/types";
import TimelineEntry from "./TimelineEntry";
import { detectDbQuery } from "@/lib/db-parser";
import type { DbQuery } from "@/lib/db-parser";

interface TimelineProps {
  events: AppEvent[];
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  sessionCwd: string;
  onOpenImage: (src: string) => void;
  collapseAllToken?: number;
}

export default function Timeline({
  events,
  activeFilters,
  showTokenUsage,
  sessionCwd,
  onOpenImage,
  collapseAllToken,
}: TimelineProps) {
  // Display newest first (reversed), skip session_start
  // Key by original (pre-reversal) index so appending new events never changes
  // existing keys — preserving each entry's collapsed/expanded state.
  const filteredEvents = events.filter((e) => e.kind !== "session_start");
  const displayEvents = filteredEvents.slice().reverse();

  // Build callId → output text map for pairing shell commands with their output
  const callIdToOutput = new Map<string, string>();
  for (const evt of filteredEvents) {
    if (evt.kind === "tool_output" && evt.callId) {
      callIdToOutput.set(evt.callId, evt.output);
    }
  }

  // For a file_change at filteredEvents[i], find the last user_message before it
  function getContextText(origIdx: number): string | undefined {
    for (let j = origIdx - 1; j >= 0; j--) {
      if (filteredEvents[j].kind === "user_message") {
        return (filteredEvents[j] as AppEvent & { text: string }).text || undefined;
      }
    }
    return undefined;
  }

  return (
    <div className="timeline">
      {displayEvents.map((evt, i) => {
        const origIdx = filteredEvents.length - 1 - i;
        const contextText = evt.kind === "file_change" ? getContextText(origIdx) : undefined;
        let dbQuery: DbQuery | undefined;
        let queryOutput: string | undefined;
        if (evt.kind === "shell_command") {
          const detected = detectDbQuery(evt.cmd);
          if (detected) {
            dbQuery = detected;
            queryOutput = evt.callId ? callIdToOutput.get(evt.callId) : undefined;
          }
        }
        return (
          <TimelineEntry
            key={origIdx}
            event={evt}
            activeFilters={activeFilters}
            showTokenUsage={showTokenUsage}
            sessionCwd={sessionCwd}
            onOpenImage={onOpenImage}
            contextText={contextText}
            collapseToken={collapseAllToken}
            dbQuery={dbQuery}
            queryOutput={queryOutput}
          />
        );
      })}
    </div>
  );
}
