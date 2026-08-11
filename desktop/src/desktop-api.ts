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
export type SessionSharingMode = "off" | "selected" | "all";

export interface PairedDevice {
  id: string;
  name: string;
  endpoint: string;
  publicKey: string;
}

export interface MeshPeerStatus {
  id: string;
  connected: boolean;
  detail: string;
}

export interface MeshStatus {
  publicKey: string;
  listening: boolean;
  peers: MeshPeerStatus[];
}

export interface ConnectMeshPeerResponse {
  connected: boolean;
  detail: string;
}

export interface SyncAllMeshPeersResponse {
  peers: MeshPeerStatus[];
}

export type ProviderRuntimeOperation =
  | "startSession"
  | "resumeSession"
  | "sendTurn"
  | "interruptTurn"
  | "respondToApproval"
  | "respondToUserInput"
  | "stopSession"
  | "listSessions"
  | "readThread"
  | "rollbackThread"
  | "changeModel";

export type ProviderTransport =
  | "codexAppServer"
  | "claudeStreamJson"
  | "agentClientProtocol"
  | "openCodeServer";

export interface AgentProviderDriver {
  instanceId: string;
  driver: string;
  displayName: string;
  executable: string;
  transport: ProviderTransport;
  supportsMultipleInstances: boolean;
  runtimeAvailable: boolean;
  requiredOperations: ProviderRuntimeOperation[];
  inventory: {
    method: "appServer" | "cliAndInit" | "cliAndAcp" | "cliAndHttp";
    version: boolean;
    authentication: boolean;
    models: boolean;
    slashCommands: boolean;
    skills: boolean;
  };
}

export interface AgentProviderSnapshot {
  instanceId: string;
  status: "checking" | "ready" | "warning" | "unavailable";
  installed: boolean | null;
  version: string | null;
  detail: string | null;
  checkedAtMs: number | null;
}

export interface AgentProviderRuntimeEvent {
  providerInstanceId: string;
  sessionKey: string;
  message: unknown;
}

export interface StartAgentProviderSessionRequest {
  providerInstanceId: string;
  sessionKey: string;
  threadId?: string;
  cwd: string;
  model?: string;
  effort?: string;
}

export interface StartedAgentProviderSession {
  providerInstanceId: string;
  threadId: string;
}

export interface ResumeAgentProviderSessionRequest {
  providerInstanceId: string;
  sessionKey: string;
  threadId: string;
  cwd: string;
}

export interface SendAgentProviderTurnRequest {
  providerInstanceId: string;
  sessionKey: string;
  threadId: string;
  turnId?: string;
  text: string;
  imageUrls: string[];
}

export interface DesktopSettings {
  appearance: DesktopAppearance;
  provider: ExplainProvider;
  model: string;
  localBaseUrl: string;
  explainInstructions: string;
  anthropicKeyConfigured: boolean;
  localKeyConfigured: boolean;
  openRouterKeyConfigured: boolean;
  sessionSharingMode: SessionSharingMode;
  pairedDevices: PairedDevice[];
}

export interface DesktopAppearanceSettings {
  appearance: DesktopAppearance;
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
  sessionSharingMode: SessionSharingMode;
  pairedDevices: PairedDevice[];
}

export interface SessionSharingSettings {
  mode: SessionSharingMode;
  sharedSessionKeys: string[];
  hasConfiguredDevice: boolean;
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

export interface WorkspaceTreeEntry {
  path: string;
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

export function listCollabRooms(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_collab_rooms");
}

export function createCollabRoom(cwd: string, name = ""): Promise<SessionMeta> {
  return invoke<SessionMeta>("create_collab_room", { request: { cwd, name } });
}

export function deleteCollabRoom(fileRef: string): Promise<number> {
  return invoke<number>("delete_collab_room", { fileRef });
}

export interface CollabWorker {
  id: string;
  name: string;
  provider: string;
  model: string;
  effort: string;
  role: string;
  worktreePath: string;
  branch: string;
  createdAt: string;
  sessionKey: string | null;
  threadId: string | null;
  runtimeStatus: "offline" | "starting" | "running" | "error";
  runtimeError: string;
}

export interface CollabTask {
  id: string;
  title: string;
  scope: string;
  status: "open" | "claimed" | "done";
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollabLease {
  id: string;
  resource: string;
  mode: "exclusive" | "shared";
  holderId: string;
  taskId: string | null;
  fencingToken: number;
  expiresAtMs: number;
  createdAt: string;
}

export interface CollabChangeSet {
  id: string;
  workerId: string;
  title: string;
  summary: string;
  baseCommit: string;
  changedPaths: string[];
  status: "review" | "approved" | "rejected" | "integrated";
  reviewerId: string | null;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
  integratedAt: string | null;
}

export interface CollabMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  recipientId: string | null;
}

export interface CollabRoomState {
  roomId: string;
  repository: string;
  headCommit: string;
  workers: CollabWorker[];
  tasks: CollabTask[];
  leases: CollabLease[];
  changeSets: CollabChangeSet[];
  messages: CollabMessage[];
}

export function getCollabRoomState(roomRef: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("get_collab_room_state", { roomRef });
}

export function addCollabWorker(roomRef: string, name: string, provider: string, model: string, effort: string, role: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("add_collab_worker", { request: { roomRef, name, provider, model, effort, role } });
}

export function createCollabTask(roomRef: string, title: string, scope: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("create_collab_task", { request: { roomRef, title, scope } });
}

export function claimCollabTask(roomRef: string, taskId: string, workerId: string | null): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("claim_collab_task", { request: { roomRef, taskId, workerId } });
}

export function acquireCollabLease(
  roomRef: string,
  holderId: string,
  taskId: string | null,
  resource: string,
  mode: "exclusive" | "shared",
  ttlSeconds: number,
): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("acquire_collab_lease", { request: { roomRef, holderId, taskId, resource, mode, ttlSeconds } });
}

export function renewCollabLease(roomRef: string, lease: CollabLease, ttlSeconds = 900): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("renew_collab_lease", { request: { roomRef, leaseId: lease.id, holderId: lease.holderId, fencingToken: lease.fencingToken, ttlSeconds } });
}

export function releaseCollabLease(roomRef: string, lease: CollabLease): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("release_collab_lease", { request: { roomRef, leaseId: lease.id, holderId: lease.holderId, fencingToken: lease.fencingToken, ttlSeconds: null } });
}

export function submitCollabChange(roomRef: string, workerId: string, title: string, summary: string, leases: CollabLease[]): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("submit_collab_change", {
    request: {
      roomRef,
      workerId,
      title,
      summary,
      leaseProofs: leases.filter((lease) => lease.holderId === workerId && lease.mode === "exclusive").map((lease) => ({ leaseId: lease.id, fencingToken: lease.fencingToken })),
    },
  });
}

export function reviewCollabChange(roomRef: string, changeSetId: string, decision: "approved" | "rejected", note: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("review_collab_change", { request: { roomRef, changeSetId, reviewerId: "local-host", decision, note } });
}

export function integrateCollabChange(roomRef: string, changeSetId: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("integrate_collab_change", { request: { roomRef, changeSetId } });
}

export function postCollabMessage(roomRef: string, body: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("post_collab_message", { request: { roomRef, authorId: "local-host", authorName: "Host", body, recipientId: null } });
}

export function updateCollabWorkerRuntime(
  roomRef: string,
  workerId: string,
  sessionKey: string | null,
  threadId: string | null,
  status: CollabWorker["runtimeStatus"],
  error = "",
): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("update_collab_worker_runtime", {
    request: { roomRef, workerId, sessionKey, threadId, status, error },
  });
}

export function postCollabAgentMessage(roomRef: string, worker: CollabWorker, body: string, direct = false): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("post_collab_message", {
    request: { roomRef, authorId: worker.id, authorName: worker.name, body, recipientId: direct ? "local-host" : null },
  });
}

export function postCollabDirectMessage(roomRef: string, workerId: string, body: string): Promise<CollabRoomState> {
  return invoke<CollabRoomState>("post_collab_message", {
    request: { roomRef, authorId: "local-host", authorName: "Host", body, recipientId: workerId },
  });
}

/** Read only the selected transcript's mtime; avoids a full session discovery scan. */
export function getSessionModified(fileRefs: string): Promise<string> {
  return invoke<string>("get_session_modified", { fileRefs });
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

export function chooseWorkspaceDirectory(): Promise<string | null> {
  return invoke<string | null>("choose_workspace_directory");
}

export function resolveWorkspaceFilepaths(workspaceRoot: string, filepaths: string[]): Promise<(string | null)[]> {
  return invoke<(string | null)[]>("resolve_workspace_filepaths", { request: { workspaceRoot, filepaths } });
}

export function listWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceTreeEntry[]> {
  return invoke<WorkspaceTreeEntry[]>("list_workspace_files", { request: { workspaceRoot } });
}

export function startTerminal(terminalId: string, workspaceRoot: string): Promise<boolean> {
  return invoke<boolean>("start_terminal", { request: { terminalId, workspaceRoot } });
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

export function ensureCodexSharedAppServer(): Promise<string> {
  return invoke<string>("ensure_codex_shared_app_server");
}

export function listAgentProviderDrivers(): Promise<AgentProviderDriver[]> {
  return invoke<AgentProviderDriver[]>("list_agent_provider_drivers");
}

export function listAgentProviderInventory(): Promise<AgentProviderSnapshot[]> {
  return invoke<AgentProviderSnapshot[]>("list_agent_provider_inventory");
}

export function refreshAgentProviderInventory(): Promise<boolean> {
  return invoke<boolean>("refresh_agent_provider_inventory");
}

export function startAgentProviderSession(
  request: StartAgentProviderSessionRequest,
): Promise<StartedAgentProviderSession> {
  return invoke<StartedAgentProviderSession>("start_agent_provider_session", { request });
}

export function resumeAgentProviderSession(request: ResumeAgentProviderSessionRequest): Promise<void> {
  return invoke<void>("resume_agent_provider_session", { request });
}

export function sendAgentProviderTurn(request: SendAgentProviderTurnRequest): Promise<void> {
  return invoke<void>("send_agent_provider_turn", { request });
}

export function connectCodexThread(sessionKey: string, threadId: string, cwd: string): Promise<void> {
  return invoke<void>("connect_codex_thread", { requestData: { sessionKey, threadId, cwd } });
}

export interface CodexWriterInfo {
  pid: number;
  command: string;
}

export function getCodexThreadWriter(threadId: string): Promise<CodexWriterInfo | null> {
  return invoke<CodexWriterInfo | null>("get_codex_thread_writer", { request: { threadId } });
}

export function takeOverCodexThread(threadId: string, pid: number): Promise<void> {
  return invoke<void>("take_over_codex_thread", { request: { threadId, pid } });
}

export interface NewCodexSession {
  id: string;
}

export function startCodexSession(sessionKey: string, cwd: string, model: string, effort = ""): Promise<NewCodexSession> {
  return invoke<NewCodexSession>("start_codex_session", { requestData: { sessionKey, cwd, model, effort: effort === "default" ? "" : effort } });
}

export interface SessionFileVersion {
  version: number;
  timestamp: string;
  content: string | null;
  baseline: boolean;
}

export function startSessionHistory(sessionKey: string, workspaceRoot: string): Promise<number> {
  return invoke<number>("start_session_history", { sessionKey, workspaceRoot });
}

export function bindSessionHistory(sessionKey: string, threadId: string): Promise<void> {
  return invoke<void>("bind_session_history", { request: { sessionKey, threadId } });
}

export function captureSessionHistory(sessionKey: string, timestamp?: string): Promise<number> {
  return invoke<number>("capture_session_history", { request: { sessionKey, timestamp } });
}

export function readSessionFileHistory(threadId: string, filepath: string): Promise<SessionFileVersion[]> {
  return invoke<SessionFileVersion[]>("read_session_file_history", { request: { threadId, filepath } });
}

export function sendCodexTurn(
  sessionKey: string,
  threadId: string,
  turnId: string | null,
  text: string,
  imageUrls: string[],
): Promise<void> {
  return invoke<void>("send_codex_turn", {
    requestData: { sessionKey, threadId, turnId, text, imageUrls },
  });
}

export function compactCodexThread(sessionKey: string, threadId: string, cwd: string): Promise<void> {
  return invoke<void>("compact_codex_thread", { requestData: { sessionKey, threadId, cwd } });
}

export interface CodexModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }>;
}

export async function listCodexModels(sessionKey: string, threadId: string, cwd: string): Promise<CodexModel[]> {
  const result = await invoke<{ data?: CodexModel[] }>("list_codex_models", {
    requestData: { sessionKey, threadId, cwd },
  });
  return Array.isArray(result.data) ? result.data : [];
}

export function setCodexThreadModel(sessionKey: string, threadId: string, cwd: string, model: string): Promise<void> {
  return invoke<void>("set_codex_thread_model", {
    requestData: { sessionKey, threadId, cwd, model },
  });
}

type CodexThreadRequest = { sessionKey: string; threadId: string; cwd: string };

export function getActiveCodexTurn(sessionKey: string, threadId: string, cwd: string): Promise<{ turnId: string | null }> {
  return invoke<{ turnId: string | null }>("get_active_codex_turn", { requestData: { sessionKey, threadId, cwd } });
}

export function readCodexThreadStatus(requestData: CodexThreadRequest): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("read_codex_thread_status", { requestData });
}

export function listCodexSkills(requestData: CodexThreadRequest): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("list_codex_skills", { requestData });
}

export function listCodexMcpServers(requestData: CodexThreadRequest): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("list_codex_mcp_servers", { requestData });
}

export function startCodexReview(requestData: CodexThreadRequest): Promise<void> {
  return invoke<void>("start_codex_review", { requestData });
}

export function interruptCodexTurn(sessionKey: string, threadId: string, turnId: string): Promise<void> {
  return invoke<void>("interrupt_codex_turn", { requestData: { sessionKey, threadId, turnId } });
}

export function respondToCodexApproval(sessionKey: string, requestId: unknown, result: unknown): Promise<void> {
  return invoke<void>("respond_to_codex_approval", { response: { sessionKey, requestId, result } });
}

export function connectClaudeThread(sessionKey: string, threadId: string, cwd: string): Promise<void> {
  return invoke<void>("connect_claude_thread", { requestData: { sessionKey, threadId, cwd } });
}

export function startClaudeSession(sessionKey: string, threadId: string, cwd: string, model: string, effort = ""): Promise<string> {
  return invoke<string>("start_claude_session", { requestData: { sessionKey, threadId, cwd, model, effort: effort === "default" ? "" : effort } });
}

export function sendClaudeTurn(sessionKey: string, text: string, imageUrls: string[]): Promise<void> {
  return invoke<void>("send_claude_turn", { requestData: { sessionKey, text, imageUrls } });
}

export function getDesktopSettings(): Promise<DesktopSettings> {
  return invoke<DesktopSettings>("get_desktop_settings");
}

export function getDesktopAppearance(): Promise<DesktopAppearanceSettings> {
  return invoke<DesktopAppearanceSettings>("get_desktop_appearance");
}

export function getMeshStatus(): Promise<MeshStatus> {
  return invoke<MeshStatus>("get_mesh_status");
}

export function regenerateMeshIdentity(): Promise<MeshStatus> {
  return invoke<MeshStatus>("regenerate_mesh_identity");
}

export function connectMeshPeer(deviceId: string): Promise<ConnectMeshPeerResponse> {
  return invoke<ConnectMeshPeerResponse>("connect_mesh_peer", { request: { deviceId } });
}

export function syncAllMeshPeers(): Promise<SyncAllMeshPeersResponse> {
  return invoke<SyncAllMeshPeersResponse>("sync_all_mesh_peers");
}

export function saveDesktopSettings(request: SaveDesktopSettingsRequest): Promise<DesktopSettings> {
  return invoke<DesktopSettings>("save_desktop_settings", { request });
}

export function getSessionSharingSettings(): Promise<SessionSharingSettings> {
  return invoke<SessionSharingSettings>("get_session_sharing_settings");
}

export function updateSessionShare(sessionKey: string, shared: boolean): Promise<SessionSharingSettings> {
  return invoke<SessionSharingSettings>("update_session_share", { request: { sessionKey, shared } });
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
