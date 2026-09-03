export interface PendingCodexSteer {
  id: string;
  text: string;
  imageUrls: string[];
  streamInput: string;
  submittedAt: number;
  afterSequence: number;
}

const STORAGE_PREFIX = "agent-vis:pending-codex-steer:";
type SteerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadPendingCodexSteers(
  sessionKey: string,
  threadId: string,
  storage: SteerStorage | null = browserStorage(),
): PendingCodexSteer[] {
  try {
    const raw = storage?.getItem(storageKey(sessionKey, threadId));
    if (!raw) return [];
    const values = JSON.parse(raw) as Partial<PendingCodexSteer>[];
    if (!Array.isArray(values)) return [];
    return values.filter(isPendingCodexSteer) as PendingCodexSteer[];
  } catch {
    return [];
  }
}

export function savePendingCodexSteers(
  sessionKey: string,
  threadId: string,
  pending: readonly PendingCodexSteer[],
  storage: SteerStorage | null = browserStorage(),
): void {
  try {
    if (!storage) return;
    if (pending.length) {
      storage.setItem(storageKey(sessionKey, threadId), JSON.stringify(pending));
    } else {
      storage.removeItem(storageKey(sessionKey, threadId));
    }
  } catch {
    // The in-memory outbox remains useful if browser storage is unavailable.
  }
}

export function codexUserMessageId(message: Record<string, unknown>): string | null {
  if (message.method !== "item/started" && message.method !== "item/completed") return null;
  const params = recordValue(message.params);
  const item = recordValue(params?.item);
  return item?.type === "userMessage" && typeof item.id === "string" ? item.id : null;
}

export function acknowledgePendingCodexSteer(
  pending: readonly PendingCodexSteer[],
  deliveredSequence: number,
): PendingCodexSteer[] {
  const index = pending.findIndex((candidate) => deliveredSequence > candidate.afterSequence);
  return index < 0 ? [...pending] : pending.filter((_, candidate) => candidate !== index);
}

function storageKey(sessionKey: string, threadId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionKey)}:${encodeURIComponent(threadId)}`;
}

function browserStorage(): SteerStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPendingCodexSteer(value: Partial<PendingCodexSteer>): boolean {
  return typeof value === "object" && value !== null
    && typeof value.id === "string" && typeof value.text === "string"
    && Array.isArray(value.imageUrls) && value.imageUrls.every((item) => typeof item === "string")
    && typeof value.streamInput === "string" && typeof value.submittedAt === "number"
    && typeof value.afterSequence === "number";
}
