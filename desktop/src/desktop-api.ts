import { invoke } from "@tauri-apps/api/core";
import type { AppEvent, SessionMeta } from "@/lib/types";
import type { SessionRecordFile } from "./session-parser";

const sessionCache = new Map<string, Promise<AppEvent[]>>();
const SESSION_BATCH_BYTES = 64 * 1024 * 1024;

interface SessionRecordBatch {
  files: SessionRecordFile[];
  cursor: number[];
  done: boolean;
}

export function listSessions(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_sessions");
}

export function readSession(
  fileRefs: string,
  modified: string,
  onProgress?: (batches: number) => void,
): Promise<AppEvent[]> {
  const cacheKey = `${fileRefs}:${modified}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) return cached;

  const pending = readSessionBatches(fileRefs, onProgress).catch((reason) => {
      sessionCache.delete(cacheKey);
      throw reason;
    });
  sessionCache.set(cacheKey, pending);
  return pending;
}

function readSessionBatches(
  fileRefs: string,
  onProgress?: (batches: number) => void,
): Promise<AppEvent[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./session-parser.worker.ts", import.meta.url), { type: "module" });
    let cursor: number[] | undefined;
    let batches = 0;
    let awaitingAppend = false;
    let doneReading = false;

    async function requestBatch() {
      try {
        const batch = await invoke<SessionRecordBatch>("read_session_records", {
          request: { fileRefs, cursor, maxBytes: SESSION_BATCH_BYTES },
        });
        cursor = batch.cursor;
        batches += 1;
        onProgress?.(batches);
        doneReading = batch.done;
        awaitingAppend = true;
        worker.postMessage({ type: "append", files: batch.files });
      } catch (reason) {
        worker.terminate();
        reject(reason);
      }
    }

    worker.onmessage = (event: MessageEvent<
      | { ok: true; appended: true }
      | { ok: true; events: AppEvent[] }
      | { ok: false; error: string }
    >) => {
      if (!event.data.ok) {
        worker.terminate();
        reject(new Error(event.data.error));
        return;
      }
      if ("events" in event.data) {
        worker.terminate();
        resolve(event.data.events);
        return;
      }
      if (awaitingAppend) {
        awaitingAppend = false;
        if (doneReading) worker.postMessage({ type: "finish" });
        else void requestBatch();
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Session parser worker failed"));
    };
    void requestBatch();
  });
}
