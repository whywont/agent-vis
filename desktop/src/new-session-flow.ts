import type { LiveProvider } from "./harness-adapters";

export interface NewSessionSelection {
  provider: LiveProvider | null;
  model: string | null;
  effort: string | null;
}

export function previousNewSessionSelection(selection: NewSessionSelection): NewSessionSelection {
  if (selection.effort !== null) return { ...selection, effort: null };
  if (selection.model !== null) return { ...selection, model: null };
  if (selection.provider !== null) return { provider: null, model: null, effort: null };
  return selection;
}
