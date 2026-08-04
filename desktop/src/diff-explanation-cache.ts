const STORAGE_PREFIX = "agent-vis:desktop:diff-explanation:";

export interface DiffExplanationIdentity {
  workspaceRoot: string;
  filepath: string;
  action: string;
  patch: string;
  contextText?: string;
}

interface ExplanationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function diffExplanationKey(identity: DiffExplanationIdentity): string {
  const serialized = JSON.stringify([
    identity.workspaceRoot,
    identity.filepath,
    identity.action,
    identity.patch,
    identity.contextText || "",
  ]);
  return `${STORAGE_PREFIX}${stableHash(serialized)}`;
}

export function detailedDiffExplanationKey(explanationKey: string): string {
  return `${explanationKey}:detailed`;
}

export function loadDiffExplanation(
  key: string,
  storage: ExplanationStorage = window.localStorage,
): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function saveDiffExplanation(
  key: string,
  explanation: string,
  storage: ExplanationStorage = window.localStorage,
): void {
  try {
    storage.setItem(key, explanation);
  } catch {
    // Keep the visible result even if storage is unavailable or full.
  }
}

export function removeDiffExplanation(
  key: string,
  storage: ExplanationStorage = window.localStorage,
): void {
  try {
    storage.removeItem(key);
  } catch {
    // A dismissed explanation can still disappear from the current component.
  }
}

function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}
