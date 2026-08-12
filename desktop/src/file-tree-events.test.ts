import { describe, expect, it } from "vitest";
import type { AppEvent } from "@/lib/types";
import { desktopFileEntries, patchForDesktopFile, remapDesktopFileEntries } from "./file-tree-events";

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

  it("prunes a renamed path that no longer exists in the workspace", () => {
    const rename: AppEvent = {
      kind: "file_change",
      ts: "2026-08-03T12:00:00Z",
      callId: "rename-1",
      patch: "*** Update File: /repo/desktop/src/DesktopLiveConversation.tsx",
      files: [
        { action: "delete", path: "/repo/desktop/src/DesktopCodexConversation.tsx" },
        { action: "add", path: "/repo/desktop/src/DesktopLiveConversation.tsx" },
      ],
    };

    const entries = desktopFileEntries([rename], "/repo");
    const visible = remapDesktopFileEntries(
      entries,
      new Map([
        ["desktop/src/DesktopCodexConversation.tsx", "desktop/src/DesktopLiveConversation.tsx"],
        ["desktop/src/DesktopLiveConversation.tsx", "desktop/src/DesktopLiveConversation.tsx"],
      ]),
    );

    expect([...visible.keys()]).toEqual(["desktop/src/DesktopLiveConversation.tsx"]);
    expect(visible.get("desktop/src/DesktopLiveConversation.tsx")?.changes).toHaveLength(2);
  });

  it("extracts only the selected file from a multi-file history patch", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /repo/Cargo.toml",
      "+[workspace]",
      "*** Add File: /repo/server/Cargo.toml",
      "+[package]",
      "*** Add File: /repo/server/src/main.rs",
      "+fn main() {}",
      "*** End Patch",
    ].join("\n");

    expect(patchForDesktopFile(patch, "server/src/main.rs", "/repo")).toBe([
      "*** Begin Patch",
      "*** Add File: /repo/server/src/main.rs",
      "+fn main() {}",
      "*** End Patch",
    ].join("\n"));
  });
});
