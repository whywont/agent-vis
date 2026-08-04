import { invoke } from "@tauri-apps/api/core";
import type { AppEvent, SessionMeta } from "@/lib/types";
import type { SessionRecordFile } from "./session-parser";
import { WeightedLruCache } from "./weighted-lru-cache";
import type { DesktopAppearance } from "./desktop-theme";

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
  appearance: DesktopAppearance;
  provider: ExplainProvider;
  model: string;
  localBaseUrl: string;
  explainInstructions: string;
  anthropicKeyConfigured: boolean;
  localKeyConfigured: boolean;
  openRouterKeyConfigured: boolean;
}

export interface SaveDesktopSettingsRequest {
  appearance: DesktopAppearance;
  provider: ExplainProvider;
  model: string;
  localBaseUrl: string;
  explainInstructions: string;
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
  fileContent?: string;
  detailLevel?: "detailed";
}

interface WorkspaceFile {
  content: string;
}

export interface SessionSearchResult {
  sessionKey: string;
  eventTs: string;
  eventKind: string;
  snippet: string;
  highlights: string[];
  matchKind: "keyword" | "concept";
  score: number;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  indexing: boolean;
  indexedFiles: number;
  totalFiles: number;
  semanticReady: boolean;
  semanticIndexing: boolean;
  semanticError?: string | null;
  error?: string | null;
}

export function listSessions(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_sessions");
}

export function searchSessions(query: string): Promise<SessionSearchResponse> {
  return invoke<SessionSearchResponse>("search_sessions", { query });
}

export function deleteSession(fileRefs: string): Promise<number> {
  return invoke<number>("delete_session", { fileRefs });
}

export function getGitBranch(workspaceRoot: string): Promise<string | null> {
  return invoke<string | null>("get_git_branch", { workspaceRoot });
}

export function startTerminal(terminalId: string, workspaceRoot: string): Promise<void> {
  return invoke<void>("start_terminal", { request: { terminalId, workspaceRoot } });
}

export function writeTerminal(terminalId: string, data: string): Promise<void> {
  return invoke<void>("write_terminal", { request: { terminalId, data } });
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("resize_terminal", { request: { terminalId, cols, rows } });
}

export function stopTerminal(terminalId: string): Promise<void> {
  return invoke<void>("stop_terminal", { request: { terminalId } });
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

export async function readWorkspaceFile(workspaceRoot: string, filepath: string): Promise<string> {
  const result = await invoke<WorkspaceFile>("read_workspace_file", {
    request: { workspaceRoot, filepath },
  });
  return result.content;
}

export async function saveWorkspaceFile(
  workspaceRoot: string,
  filepath: string,
  expectedContent: string,
  content: string,
): Promise<string> {
  const result = await invoke<WorkspaceFile>("save_workspace_file", {
    request: { workspaceRoot, filepath, expectedContent, content },
  });
  return result.content;
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
