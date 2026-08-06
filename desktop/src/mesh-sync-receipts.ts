import type { SessionMeta } from "@/lib/types";
import type { SessionSharingSettings } from "./desktop-api";
import { sessionIdentity } from "./session-refresh";

const MESH_SYNC_RECEIPTS_KEY = "agent-vis-mesh-sync-receipts";

interface ReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type MeshSyncReceipts = Record<string, string>;

export function sessionRevision(session: SessionMeta): string {
  return JSON.stringify([
    session.modified,
    session.timestamp,
    session.files?.join(",") || session.file,
  ]);
}

export function loadMeshSyncReceipts(
  storage: ReceiptStorage = window.localStorage,
): MeshSyncReceipts {
  try {
    const raw = storage.getItem(MESH_SYNC_RECEIPTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function saveMeshSyncReceipts(
  receipts: MeshSyncReceipts,
  storage: ReceiptStorage = window.localStorage,
): void {
  try {
    storage.setItem(MESH_SYNC_RECEIPTS_KEY, JSON.stringify(receipts));
  } catch {
    // The marker still works for this run if persistent storage is unavailable.
  }
}

export function recordSuccessfulMeshSync(
  sessions: SessionMeta[],
  sharing: Pick<SessionSharingSettings, "mode" | "sharedSessionKeys">,
  current: MeshSyncReceipts,
): MeshSyncReceipts {
  const selected = new Set(sharing.sharedSessionKeys);
  const next: MeshSyncReceipts = {};

  for (const session of sessions) {
    const identity = sessionIdentity(session);
    if (current[identity]) next[identity] = current[identity];
    if (session.synced) continue;

    const shared = sharing.mode === "all"
      || (sharing.mode === "selected" && selected.has(identity));
    if (shared) next[identity] = sessionRevision(session);
  }

  return next;
}

export function hasCurrentMeshSyncReceipt(
  session: SessionMeta,
  receipts: MeshSyncReceipts,
): boolean {
  return !session.synced
    && receipts[sessionIdentity(session)] === sessionRevision(session);
}
