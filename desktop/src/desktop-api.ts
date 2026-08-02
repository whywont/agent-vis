import { invoke } from "@tauri-apps/api/core";
import type { SessionMeta } from "../../src/lib/types";

export function listSessions(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_sessions");
}
