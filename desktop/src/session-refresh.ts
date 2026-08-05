import type { SessionMeta } from "@/lib/types";

export function sessionIdentity(session: SessionMeta): string {
  return `${session.source}:${session.id || session.file}`;
}

export function sessionListsEqual(current: SessionMeta[], next: SessionMeta[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((session, index) => {
    const candidate = next[index];
    return sessionIdentity(session) === sessionIdentity(candidate)
      && session.modified === candidate.modified
      && session.timestamp === candidate.timestamp
      && (session.files?.join(",") || session.file) === (candidate.files?.join(",") || candidate.file);
  });
}

export function refreshSelectedSession(
  selected: SessionMeta | null,
  sessions: SessionMeta[],
): SessionMeta | null {
  if (!selected) return null;
  const identity = sessionIdentity(selected);
  const refreshed = sessions.find((session) => sessionIdentity(session) === identity);
  if (!refreshed) return null;
  return sessionListsEqual([selected], [refreshed]) ? selected : refreshed;
}

/** Keep a just-created harness thread visible until its JSONL record exists. */
export function mergeRefreshedSessions(
  current: SessionMeta[],
  refreshed: SessionMeta[],
): SessionMeta[] {
  const pending = current.filter((session) => session.file.startsWith("live:")
    && !refreshed.some((next) => next.source === session.source && next.id === session.id));
  return [...pending, ...refreshed];
}

export function refreshSelectedSessionWithLive(
  selected: SessionMeta | null,
  refreshed: SessionMeta[],
): SessionMeta | null {
  return refreshSelectedSession(selected, refreshed)
    || (selected?.file.startsWith("live:") ? selected : null);
}
