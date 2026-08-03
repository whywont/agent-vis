import { describe, expect, it } from "vitest";
import { workspaceRelativePath } from "./workspace-path";

describe("workspaceRelativePath", () => {
  it("removes the session workspace prefix from absolute paths", () => {
    expect(workspaceRelativePath(
      "/Users/andrew/agent-vis/desktop/src/App.tsx",
      "/Users/andrew/agent-vis",
    )).toBe("desktop/src/App.tsx");
  });

  it("does not strip roots that only share a prefix", () => {
    expect(workspaceRelativePath("/work/project-old/file.ts", "/work/project")).toBe("/work/project-old/file.ts");
  });

  it("keeps already-relative paths unchanged", () => {
    expect(workspaceRelativePath("desktop/src/App.tsx", "/Users/andrew/agent-vis/")).toBe("desktop/src/App.tsx");
  });
});
