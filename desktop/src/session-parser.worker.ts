/// <reference lib="webworker" />

import { SessionRecordParser, type SessionRecordFile } from "./session-parser";

const parser = new SessionRecordParser();

self.onmessage = (event: MessageEvent<
  | { type: "append"; files: SessionRecordFile[] }
  | { type: "finish" }
>) => {
  try {
    if (event.data.type === "append") {
      parser.append(event.data.files);
      self.postMessage({ ok: true, appended: true });
      return;
    }
    self.postMessage({ ok: true, events: parser.finish() });
  } catch (reason) {
    self.postMessage({
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
};
