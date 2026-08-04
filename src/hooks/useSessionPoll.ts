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
  const initializedRef = useRef(false);

  // Keep callback ref current without resetting the interval (standard stale-closure pattern)
  // eslint-disable-next-line react-hooks/refs
  callbackRef.current = onNewEvents;

  useEffect(() => {
    fileRef.current = file;
    if (!file) return;
    initializedRef.current = false;

    // Start at zero and let the caller de-duplicate the initial snapshot. This
    // avoids skipping events appended while the detail view first loads.
    fetch(`/api/session-poll/${encodeURIComponent(file)}?offset=0`)
      .then((r) => r.json())
      .then((data: { events: AppEvent[]; total: number }) => {
        offsetRef.current = data.total;
        initializedRef.current = true;
        if (data.events.length > 0) callbackRef.current(data.events);
      })
      .catch(() => {});

    timerRef.current = setInterval(async () => {
      if (fileRef.current !== file) return;
      if (!initializedRef.current) return;
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
