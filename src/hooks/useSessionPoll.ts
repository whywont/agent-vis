import { useEffect, useRef } from "react";
import type { AppEvent } from "@/lib/types";

export function useSessionPoll(
  file: string | null,
  onNewEvents: (events: AppEvent[]) => void,
  pollInterval = 2000
) {
  const offsetRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef(file);
  const callbackRef = useRef(onNewEvents);

  // Keep callback ref current without resetting the interval (standard stale-closure pattern)
  // eslint-disable-next-line react-hooks/refs
  callbackRef.current = onNewEvents;

  useEffect(() => {
    fileRef.current = file;
    if (!file) return;

    // Initialize the offset to current end of file
    fetch(`/api/session-poll/${encodeURIComponent(file)}?offset=999999`)
      .then((r) => r.json())
      .then((data: { total: number }) => {
        offsetRef.current = data.total;
      })
      .catch(() => {});

    timerRef.current = setInterval(async () => {
      if (fileRef.current !== file) return;
      try {
        const res = await fetch(
          `/api/session-poll/${encodeURIComponent(file)}?offset=${offsetRef.current}`
        );
        const data = (await res.json()) as { events: AppEvent[]; total: number };
        if (data.events.length > 0) {
          offsetRef.current = data.total;
          callbackRef.current(data.events);
        }
      } catch {}
    }, pollInterval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [file, pollInterval]);
}
