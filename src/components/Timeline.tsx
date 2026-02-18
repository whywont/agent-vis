"use client";

import type { AppEvent } from "@/lib/types";
import TimelineEntry from "./TimelineEntry";

interface TimelineProps {
  events: AppEvent[];
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  sessionCwd: string;
  onOpenImage: (src: string) => void;
}

export default function Timeline({
  events,
  activeFilters,
  showTokenUsage,
  sessionCwd,
  onOpenImage,
}: TimelineProps) {
  // Display newest first (reversed), skip session_start
  // Key by original (pre-reversal) index so appending new events never changes
  // existing keys — preserving each entry's collapsed/expanded state.
  const filteredEvents = events.filter((e) => e.kind !== "session_start");
  const displayEvents = filteredEvents.slice().reverse();

  return (
    <div className="timeline">
      {displayEvents.map((evt, i) => (
        <TimelineEntry
          key={filteredEvents.length - 1 - i}
          event={evt}
          activeFilters={activeFilters}
          showTokenUsage={showTokenUsage}
          sessionCwd={sessionCwd}
          onOpenImage={onOpenImage}
        />
      ))}
    </div>
  );
}
