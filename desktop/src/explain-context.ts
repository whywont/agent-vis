import type { AppEvent } from "@/lib/types";

export function precedingUserRequest(events: AppEvent[], timestamp: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === "user_message" && event.ts <= timestamp) return event.text || undefined;
  }
  return undefined;
}
