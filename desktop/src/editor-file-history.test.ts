import { describe, expect, it } from "vitest";
import type { FileChangeEvent } from "@/lib/types";
import { buildFileHistorySnapshot, historyChangesForFile, recordedSnapshotOverlay, snapshotHistoryOverlay } from "./editor-file-history";

function change(ts: string, patch: string): FileChangeEvent {
  return { kind: "file_change", ts, patch, files: [{ action: "update", path: "src/app.ts" }] };
}

describe("buildFileHistorySnapshot", () => {
  it("exposes every matching timeline revision to the editor", () => {
    const changes = Array.from({ length: 12 }, (_value, index) => change(
      String(index + 1),
      `*** Update File: src/app.ts\n@@ -1 +1 @@\n-${index}\n+${index + 1}`,
    ));
    expect(historyChangesForFile(
      [{ kind: "user_message", ts: "0", text: "change it" }, ...changes],
      "src/app.ts",
      "/repo",
    )).toHaveLength(12);
  });

  it("overlays the selected patch on the current complete file", () => {
    const changes = [
      change("1", "*** Update File: src/app.ts\n@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;\n const tail = true;"),
      change("2", "*** Update File: src/app.ts\n@@ -1,2 +1,2 @@\n const value = 2;\n-const tail = true;\n+const tail = false;"),
    ];
    const snapshot = buildFileHistorySnapshot("const value = 2;\nconst tail = false;", changes, 0, "src/app.ts", "/repo");
    expect(snapshot.content).toBe("const value = 2;\nconst tail = false;");
    expect(snapshot.overlay.addedLines).toEqual([1]);
    expect(snapshot.overlay.changeBlocks).toEqual([{ beforeLine: 1, removedLines: ["const value = 1;"], addedLines: [] }]);
  });

  it("handles Claude Edit patches with their display separator", () => {
    const edit: FileChangeEvent = {
      kind: "file_change",
      ts: "1",
      patch: "*** Update File: src/app.ts\n- const value = 1;\n+ const value = 2;",
      files: [{ action: "update", path: "src/app.ts" }],
      toolName: "Edit",
    };
    const snapshot = buildFileHistorySnapshot("const value = 2;", [edit], 0, "src/app.ts", "/repo");
    expect(snapshot.content).toBe("const value = 2;");
    expect(snapshot.overlay.addedLines).toEqual([1]);
    expect(snapshot.overlay.changeBlocks[0]?.removedLines).toEqual(["const value = 1;"]);
  });

  it("shows an inline patch block when later edits removed the selected lines", () => {
    const selected = change("1", "*** Update File: src/app.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;");
    const snapshot = buildFileHistorySnapshot("const value = 9;", [selected], 0, "src/app.ts", "/repo");
    expect(snapshot.overlay.addedLines).toEqual([]);
    expect(snapshot.overlay.changeBlocks).toEqual([{
      beforeLine: 1,
      removedLines: ["const value = 1;"],
      addedLines: ["const value = 2;"],
    }]);
  });
});

describe("snapshotHistoryOverlay", () => {
  it("keeps the reference baseline clean", () => {
    expect(recordedSnapshotOverlay(null, "one\ntwo", true)).toEqual({
      addedLines: [],
      changeBlocks: [],
    });
  });

  it("marks the changed portion between complete file snapshots", () => {
    expect(snapshotHistoryOverlay("one\ntwo\nthree", "one\nchanged\nthree")).toEqual({
      addedLines: [2],
      changeBlocks: [{ beforeLine: 2, removedLines: ["two"], addedLines: [] }],
    });
  });

  it("handles a newly created file", () => {
    expect(snapshotHistoryOverlay(null, "one\ntwo")).toEqual({ addedLines: [1, 2], changeBlocks: [] });
  });
});
