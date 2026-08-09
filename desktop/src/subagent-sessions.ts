import type { SessionMeta } from "@/lib/types";

export function subagentChildren(sessions: SessionMeta[]): Map<string, SessionMeta[]> {
  const children = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const siblings = children.get(session.parentSessionId) || [];
    siblings.push(session);
    children.set(session.parentSessionId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => right.modified.localeCompare(left.modified));
  }
  return children;
}

export function topLevelSessions(sessions: SessionMeta[]): SessionMeta[] {
  const ids = new Set(sessions.map((session) => session.id));
  return sessions.filter((session) => !session.parentSessionId || !ids.has(session.parentSessionId));
}

export function subagentLabel(session: SessionMeta): string {
  return session.agentNickname
    || session.agentPath?.split("/").filter(Boolean).at(-1)
    || session.id.slice(0, 12);
}

export function descendantSessions(parentId: string, children: Map<string, SessionMeta[]>): SessionMeta[] {
  return (children.get(parentId) || []).flatMap((child) => [child, ...descendantSessions(child.id, children)]);
}
