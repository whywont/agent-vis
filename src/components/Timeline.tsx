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
  const rawEvents = events.filter((e) => e.kind !== "session_start");

  // Content-based dedup: Codex emits event_msg + response_item for the same
  // message, producing two events with identical content. Use a fingerprint of
  // (kind + first 120 chars of content) — timestamps can differ so we can't
  // rely on them alone.
  function fingerprint(e: AppEvent): string {
    switch (e.kind) {
      case "user_message":  return "u:" + (e.text || "").slice(0, 120);
      case "agent_message": return "a:" + (e.text || "").slice(0, 120);
      case "reasoning":     return "r:" + (e.text || "").slice(0, 120);
      case "shell_command": return "s:" + e.ts + ":" + e.cmd.slice(0, 80);
      case "file_change":   return "f:" + e.ts + ":" + e.files.map(f => f.path).join(",");
      case "tool_output":   return "o:" + (e.callId || e.ts);
      default:              return e.kind + ":" + e.ts;
    }
  }
  const seen = new Set<string>();
  const filteredEvents = rawEvents.filter((e) => {
    const key = fingerprint(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const displayEvents = filteredEvents.slice().reverse();

  // Build callId → output text map for pairing shell commands with their output
  const callIdToOutput = new Map<string, string>();
  for (const evt of filteredEvents) {
    if (evt.kind === "tool_output" && evt.callId) {
      callIdToOutput.set(evt.callId, evt.output);
    }
  }

  // Track Read tool call IDs so we can suppress their paired tool_output events
  // (the output is shown inline with the shell_command entry instead)
  const inlinedCallIds = new Set<string>();
  for (const evt of filteredEvents) {
    if (evt.kind === "shell_command" && evt.toolName === "Read" && evt.callId) {
      inlinedCallIds.add(evt.callId);
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
        let readContent: string | undefined;
        if (evt.kind === "shell_command") {
          const detected = detectDbQuery(evt.cmd);
          if (detected) {
            dbQuery = detected;
            queryOutput = evt.callId ? callIdToOutput.get(evt.callId) : undefined;
          } else if (evt.toolName === "Read" && evt.callId) {
            readContent = callIdToOutput.get(evt.callId);
          }
        }

        // Suppress tool_output events already shown inline with their Read call
        if (evt.kind === "tool_output" && evt.callId && inlinedCallIds.has(evt.callId)) {
          return null;
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
            readContent={readContent}
          />
        );
      })}
    </div>
  );
}
