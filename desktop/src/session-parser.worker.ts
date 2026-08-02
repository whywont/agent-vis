/// <reference lib="webworker" />

import { parseSessionRecords, type SessionRecordFile } from "./session-parser";

const files = new Map<string, SessionRecordFile>();

self.onmessage = (event: MessageEvent<
  | { type: "append"; files: SessionRecordFile[] }
  | { type: "finish" }
>) => {
  try {
    if (event.data.type === "append") {
      for (const incoming of event.data.files) {
        const existing = files.get(incoming.file);
        if (existing) existing.lines.push(...incoming.lines);
        else files.set(incoming.file, { ...incoming, lines: [...incoming.lines] });
      }
      self.postMessage({ ok: true, appended: true });
      return;
    }
    self.postMessage({ ok: true, events: parseSessionRecords([...files.values()]) });
  } catch (reason) {
    self.postMessage({
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
};
