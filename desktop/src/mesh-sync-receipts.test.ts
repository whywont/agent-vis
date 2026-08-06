import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/types";
import {
  hasCurrentMeshSyncReceipt,
  loadMeshSyncReceipts,
  recordSuccessfulMeshSync,
  saveMeshSyncReceipts,
} from "./mesh-sync-receipts";

function session(id: string, modified = "2026-08-06T12:00:00Z", synced = false): SessionMeta {
  return {
    file: `/sessions/${id}.jsonl`,
    id,
    cwd: "/workspace",
    model: "codex",
    timestamp: "2026-08-06T11:00:00Z",
    modified,
    cli_version: "1",
    source: "codex",
    synced,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("mesh sync receipts", () => {
  it("records only selected local sessions after a successful sync", () => {
    const first = session("first");
    const second = session("second");
    const received = session("received", undefined, true);

    const receipts = recordSuccessfulMeshSync(
      [first, second, received],
      { mode: "selected", sharedSessionKeys: ["codex:first"] },
      {},
    );

    expect(hasCurrentMeshSyncReceipt(first, receipts)).toBe(true);
    expect(hasCurrentMeshSyncReceipt(second, receipts)).toBe(false);
    expect(hasCurrentMeshSyncReceipt(received, receipts)).toBe(false);
  });

  it("records every local session in all mode and invalidates changed revisions", () => {
    const first = session("first");
    const receipts = recordSuccessfulMeshSync(
      [first],
      { mode: "all", sharedSessionKeys: [] },
      {},
    );

    expect(hasCurrentMeshSyncReceipt(first, receipts)).toBe(true);
    expect(hasCurrentMeshSyncReceipt(
      session("first", "2026-08-06T12:01:00Z"),
      receipts,
    )).toBe(false);
  });

  it("persists receipts and ignores malformed storage", () => {
    const storage = memoryStorage();
    saveMeshSyncReceipts({ "codex:first": "revision" }, storage);
    expect(loadMeshSyncReceipts(storage)).toEqual({ "codex:first": "revision" });

    storage.setItem("agent-vis-mesh-sync-receipts", "not-json");
    expect(loadMeshSyncReceipts(storage)).toEqual({});
  });
});
