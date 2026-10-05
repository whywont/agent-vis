import { describe, expect, it } from "vitest";
import { parseGitDiff, sessionRepoPaths, toViewerPatch } from "./branch-diff";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "diff --git a/new file.md b/new file.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/new file.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "\\ No newline at end of file",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old.txt b/moved.txt",
  "similarity index 100%",
  "rename from old.txt",
  "rename to moved.txt",
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

describe("parseGitDiff", () => {
  const files = parseGitDiff(DIFF);

  it("reads each file's path and status", () => {
    expect(files.map(({ path, oldPath, status, binary }) => ({ path, oldPath, status, binary }))).toEqual([
      { path: "src/app.ts", oldPath: undefined, status: "modified", binary: false },
      { path: "new file.md", oldPath: undefined, status: "added", binary: false },
      { path: "gone.txt", oldPath: undefined, status: "deleted", binary: false },
      { path: "moved.txt", oldPath: "old.txt", status: "renamed", binary: false },
      { path: "logo.png", oldPath: undefined, status: "modified", binary: true },
    ]);
  });

  it("keeps hunk content but not file headers", () => {
    expect(files[0].lines).toEqual(["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"]);
    expect(files[3].lines).toEqual([]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseGitDiff("")).toEqual([]);
  });
});

describe("toViewerPatch", () => {
  it("uses the action header DesktopDiffView expects", () => {
    const [modified, added, deleted] = parseGitDiff(DIFF);
    expect(toViewerPatch(modified).split("\n")[0]).toBe("*** Update File: src/app.ts");
    expect(toViewerPatch(added).split("\n")[0]).toBe("*** Add File: new file.md");
    expect(toViewerPatch(deleted)).toBe("*** Delete File: gone.txt\n@@ -1 +0,0 @@\n-bye");
  });
});

describe("sessionRepoPaths", () => {
  it("collects changed files, command folders, and cd targets", () => {
    expect(sessionRepoPaths([
      { kind: "file_change", ts: "", patch: "", files: [{ action: "update", path: "/Users/me/manticore/README.md" }] },
      { kind: "shell_command", ts: "", cmd: "cd ~/manticore && git status", workdir: "" },
      { kind: "shell_command", ts: "", cmd: "git -C '/Users/me/other repo' log; cd src", workdir: "/Users/me" },
      { kind: "shell_command", ts: "", cmd: "echo cd-not-a-command", workdir: "" },
      { kind: "agent_message", ts: "", text: "cd /ignored" },
    ])).toEqual(["/Users/me/manticore/README.md", "~/manticore", "/Users/me", "src", "/Users/me/other repo"]);
  });
});
