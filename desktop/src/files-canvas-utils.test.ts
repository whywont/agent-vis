import { describe, expect, it } from "vitest";
import type { FileChangeEvent } from "@/lib/types";
import { buildImportEdges, computeFilesCanvasLayout, groupFileChanges } from "./files-canvas-utils";

function change(ts: string, path: string, patch = "", action: "add" | "update" | "delete" = "update"): FileChangeEvent {
  return { kind: "file_change", ts, patch, files: [{ path, action }] };
}

describe("desktop files canvas data", () => {
  it("groups repeated changes into one sorted file stack", () => {
    const groups = groupFileChanges([
      change("2026-08-02T00:00:01Z", "src/z.ts"),
      change("2026-08-02T00:00:02Z", "README.md"),
      change("2026-08-02T00:00:03Z", "src/z.ts"),
      change("2026-08-02T00:00:04Z", "src/a.ts"),
    ]);

    expect(groups.map((group) => group.name)).toEqual([".", "src"]);
    expect(groups[1].files.map((file) => file.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(groups[1].files[1].changes).toHaveLength(2);
  });

  it("shows absolute changed files relative to the session workspace", () => {
    const groups = groupFileChanges([
      change("1", "/Users/andrew/agent-vis/desktop/src/App.tsx"),
      change("2", "/Users/andrew/agent-vis/desktop/src-tauri/src/lib.rs"),
    ], "/Users/andrew/agent-vis");

    expect(groups.map((group) => group.name)).toEqual(["desktop/src", "desktop/src-tauri/src"]);
    expect(groups[0].files[0].path).toBe("desktop/src/App.tsx");
  });

  it("lays out additional versions as visible card peeks", () => {
    const groups = groupFileChanges([
      change("1", "src/a.ts"),
      change("2", "src/a.ts"),
      change("3", "src/b.ts"),
    ]);
    const layout = computeFilesCanvasLayout(groups);

    expect(layout.directories[0].cards[0].w).toBe(316);
    expect(layout.directories[0].cards[0].h).toBe(395);
    expect(layout.directories[0].cards[1].x).toBeGreaterThan(layout.directories[0].cards[0].x);
  });

  it("connects relative and aliased imports to changed files", () => {
    const groups = groupFileChanges([
      change("1", "src/App.tsx", "*** Update File: src/App.tsx\n+import { helper } from './lib/helper';\n+import Button from '@/components/Button';"),
      change("2", "src/lib/helper.ts"),
      change("3", "src/components/Button.tsx"),
    ]);

    expect(buildImportEdges(groups)).toEqual([
      { from: "src/App.tsx", to: "src/lib/helper.ts", label: "{ helper }" },
      { from: "src/App.tsx", to: "src/components/Button.tsx", label: "Button" },
    ]);
  });
});
