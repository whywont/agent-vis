import type { AppEvent } from "@/lib/types";

export type GitFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  binary: boolean;
  /** Hunk headers and +/-/context lines, without the file headers. */
  lines: string[];
}

/** Split `git diff` output into one entry per file. */
export function parseGitDiff(diff: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  let current: GitDiffFile | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: headerPath(line), status: "modified", binary: false, lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      current.lines.push(line);
      continue;
    }
    if (inHunk) {
      // A trailing empty string is the final newline, not a context line.
      if (line !== "") current.lines.push(line);
      continue;
    }
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) current.binary = true;
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") current.path = stripPrefix(line.slice(4));
    else if (line.startsWith("--- ") && line !== "--- /dev/null" && current.status === "deleted") current.path = stripPrefix(line.slice(4));
  }
  return files;
}

/** Render one file in the `*** Update File:` patch form DesktopDiffView reads. */
export function toViewerPatch(file: GitDiffFile): string {
  const action = file.status === "added" ? "Add" : file.status === "deleted" ? "Delete" : "Update";
  return [`*** ${action} File: ${file.path}`, ...file.lines].join("\n");
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

// `diff --git a/x b/x`; only used until a ---/+++ or rename line names the file.
function headerPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  const split = rest.lastIndexOf(" b/");
  return split >= 0 ? rest.slice(split + 3) : stripPrefix(rest);
}

const CD_TARGET = /(?:^|&&|;|\|\|)\s*(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;
const GIT_C_TARGET = /\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;

/**
 * Paths a session worked in: files it changed, folders its commands ran in,
 * and `cd` / `git -C` targets. A session started in `~` that edits
 * `~/project` only reveals the repository this way.
 */
export function sessionRepoPaths(events: AppEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (event.kind === "file_change") paths.push(...event.files.map((file) => file.path));
    if (event.kind === "shell_command") {
      if (event.workdir) paths.push(event.workdir);
      for (const pattern of [CD_TARGET, GIT_C_TARGET]) {
        for (const match of event.cmd.matchAll(pattern)) paths.push(match[1].replace(/^["']|["']$/g, ""));
      }
    }
  }
  return [...new Set(paths)];
}
