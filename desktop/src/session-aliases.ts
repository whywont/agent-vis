import type { SessionMeta } from "@/lib/types";
import { sessionIdentity } from "./session-refresh";

const SESSION_ALIASES_KEY = "agent-vis:desktop:session-aliases";
export const MAX_SESSION_ALIAS_LENGTH = 120;

interface AliasStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SessionAliases = Record<string, string>;

export function loadSessionAliases(storage: AliasStorage = window.localStorage): SessionAliases {
  try {
    const raw = storage.getItem(SESSION_ALIASES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) => {
        const alias = normalizeSessionAlias(value);
        return alias ? [[key, alias]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function saveSessionAlias(
  aliases: SessionAliases,
  session: SessionMeta,
  value: string,
  storage: AliasStorage = window.localStorage,
): SessionAliases {
  const next = { ...aliases };
  const key = sessionIdentity(session);
  const alias = normalizeSessionAlias(value);
  if (alias) next[key] = alias;
  else delete next[key];
  try {
    storage.setItem(SESSION_ALIASES_KEY, JSON.stringify(next));
  } catch {
    // The renamed session remains visible for the current app run.
  }
  return next;
}

export function sessionAlias(aliases: SessionAliases, session: SessionMeta): string | null {
  return aliases[sessionIdentity(session)] || null;
}

function normalizeSessionAlias(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_SESSION_ALIAS_LENGTH);
}
