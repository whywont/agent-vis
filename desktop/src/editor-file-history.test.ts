import { describe, expect, it } from "vitest";
import type { FileChangeEvent } from "@/lib/types";
import { buildFileHistorySnapshot, historyChangesForFile, recordedSnapshotOverlay, snapshotHistoryOverlay, unrecordedHistoryChanges } from "./editor-file-history";

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

describe("unrecordedHistoryChanges", () => {
  it("keeps only timeline patches not represented by persisted content", () => {
    const changes = [
      change("2026-08-13T12:48:00Z", "*** Update File: src/app.ts\n-old\n+first"),
      change("2026-08-13T12:49:00Z", "*** Update File: src/app.ts\n-first\n+second"),
      change("2026-08-13T12:51:00Z", "*** Update File: src/app.ts\n-second\n+pending"),
    ];

    expect(unrecordedHistoryChanges(changes, [
      { timestamp: "2026-08-13T12:47:00Z", baseline: true, content: "old" },
      { timestamp: "2026-08-13T12:50:00Z", baseline: false, content: "second" },
    ], "src/app.ts", "/repo")).toEqual([changes[2]]);
  });

  it("does not treat an imported baseline as proof that timeline patches were captured", () => {
    const changes = [change(
      "2026-08-13T12:49:00Z",
      "*** Update File: src/app.ts\n-old\n+new",
    )];

    expect(unrecordedHistoryChanges(changes, [
      { timestamp: "2026-08-13T13:00:00Z", baseline: true, content: "new" },
    ], "src/app.ts", "/repo")).toEqual(changes);
  });

  it("does not hide a patch behind an unrelated nearby snapshot", () => {
    const pending = change(
      "2026-08-13T12:49:00Z",
      "*** Update File: src/app.ts\n@@ -1 +1 @@\n-old\n+expected",
    );

    expect(unrecordedHistoryChanges([pending], [
      { timestamp: "2026-08-13T12:49:01Z", baseline: false, content: "different" },
    ], "src/app.ts", "/repo")).toEqual([pending]);
  });

  it("recognizes persisted file deletions", () => {
    const deletion: FileChangeEvent = {
      kind: "file_change",
      ts: "2026-08-13T12:49:00Z",
      patch: "*** Delete File: src/app.ts\n-old",
      files: [{ action: "delete", path: "src/app.ts" }],
    };

    expect(unrecordedHistoryChanges([deletion], [
      { timestamp: "2026-08-13T12:48:00Z", baseline: true, content: "old" },
      { timestamp: "2026-08-13T12:49:00Z", baseline: false, content: null },
    ], "src/app.ts", "/repo")).toEqual([]);
  });
});
