import { invoke } from "@tauri-apps/api/core";
import type { AppEvent, SessionMeta } from "@/lib/types";
import type { SessionRecordFile } from "./session-parser";
import { WeightedLruCache } from "./weighted-lru-cache";

const SESSION_CACHE_BYTES = 512 * 1024 * 1024;
const sessionCache = new WeightedLruCache<AppEvent[]>(SESSION_CACHE_BYTES);
const sessionReads = new Map<string, Promise<AppEvent[]>>();
const SESSION_BATCH_BYTES = 64 * 1024 * 1024;

interface SessionRecordBatch {
  files: SessionRecordFile[];
  cursor: number[];
  done: boolean;
  totalBytes: number;
}

export type ExplainProvider = "anthropic" | "openai-compatible" | "openrouter";

export interface DesktopSettings {
  provider: ExplainProvider;
  model: string;
  localBaseUrl: string;
  anthropicKeyConfigured: boolean;
  localKeyConfigured: boolean;
  openRouterKeyConfigured: boolean;
}

export interface SaveDesktopSettingsRequest {
  provider: ExplainProvider;
  model: string;
  localBaseUrl: string;
  anthropicApiKey: string;
  localApiKey: string;
  openRouterApiKey: string;
  clearAnthropicApiKey: boolean;
  clearLocalApiKey: boolean;
  clearOpenRouterApiKey: boolean;
}

export interface ExplainDiffRequest {
  filepath: string;
  patch: string;
  contextText?: string;
}

export function listSessions(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_sessions");
}

export function getDesktopSettings(): Promise<DesktopSettings> {
  return invoke<DesktopSettings>("get_desktop_settings");
}

export function saveDesktopSettings(request: SaveDesktopSettingsRequest): Promise<DesktopSettings> {
  return invoke<DesktopSettings>("save_desktop_settings", { request });
}

export function explainDiff(request: ExplainDiffRequest): Promise<string> {
  return invoke<string>("explain_diff", { request });
}

export function readSession(
  fileRefs: string,
  modified: string,
  onProgress?: (batches: number) => void,
): Promise<AppEvent[]> {
  const cacheKey = `${fileRefs}:${modified}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const activeRead = sessionReads.get(cacheKey);
  if (activeRead) return activeRead;

  const pending = readSessionBatches(fileRefs, onProgress).then(({ events, totalBytes }) => {
    sessionCache.set(cacheKey, events, totalBytes);
    return events;
  }).catch((reason) => {
      sessionCache.delete(cacheKey);
      throw reason;
    }).finally(() => {
      sessionReads.delete(cacheKey);
    });
  sessionReads.set(cacheKey, pending);
  return pending;
}

function readSessionBatches(
  fileRefs: string,
  onProgress?: (batches: number) => void,
): Promise<{ events: AppEvent[]; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./session-parser.worker.ts", import.meta.url), { type: "module" });
    let cursor: number[] | undefined;
    let batches = 0;
    let awaitingAppend = false;
    let doneReading = false;
    let totalBytes = 0;

    async function requestBatch() {
      try {
        const batch = await invoke<SessionRecordBatch>("read_session_records", {
          request: { fileRefs, cursor, maxBytes: SESSION_BATCH_BYTES },
        });
        cursor = batch.cursor;
        totalBytes = batch.totalBytes;
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
        resolve({ events: event.data.events, totalBytes });
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
