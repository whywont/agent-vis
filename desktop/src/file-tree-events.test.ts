import { describe, expect, it } from "vitest";
import type { AppEvent } from "@/lib/types";
import { desktopFileEntries } from "./file-tree-events";

describe("desktopFileEntries", () => {
  it("keeps multiple patches for one file and removes exact duplicates", () => {
    const first: AppEvent = {
      kind: "file_change",
      ts: "2026-08-03T12:00:00Z",
      callId: "edit-1",
      patch: "*** Update File: /repo/src/app.ts\n- one\n+ two",
      files: [{ action: "update", path: "/repo/src/app.ts" }],
    };
    const second: AppEvent = {
      kind: "file_change",
      ts: "2026-08-03T12:00:01Z",
      callId: "edit-2",
      patch: "*** Update File: /repo/src/app.ts\n- two\n+ three",
      files: [{ action: "update", path: "/repo/src/app.ts" }],
    };

    expect(desktopFileEntries([first, { ...first }, second], "/repo").get("src/app.ts")?.changes).toHaveLength(2);
  });
});
