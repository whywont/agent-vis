import { describe, it, expect } from "vitest";
import { toCompactMarkdown } from "@/lib/compact-utils";
import type { AppEvent } from "@/lib/types";

const TS = "2024-03-15T14:30:00.000Z";

function sessionStart(cwd = "/Users/alice/myproject", model = "claude"): AppEvent {
  return { kind: "session_start", ts: TS, id: "sess-1", cwd, model };
}

function userMsg(text: string): AppEvent {
  return { kind: "user_message", ts: TS, text };
}

function agentMsg(text: string): AppEvent {
  return { kind: "agent_message", ts: TS, text };
}

function shellCmd(cmd: string, workdir = ""): AppEvent {
  return { kind: "shell_command", ts: TS, cmd, workdir };
}

const hdr = (verb: string, file: string) => `${"***"} ${verb} File: ${file}`;

function fileChange(filePath: string, action: "add" | "update" | "delete"): AppEvent {
  return {
    kind: "file_change",
    ts: TS,
    patch: hdr(action === "add" ? "Add" : action === "update" ? "Update" : "Delete", filePath) + "\n+ line",
    files: [{ action, path: filePath }],
  };
}

// ---------------------------------------------------------------------------

describe("toCompactMarkdown — header section", () => {
  it("uses the cwd folder name as the session title", () => {
    const md = toCompactMarkdown([sessionStart("/Users/alice/myproject")]);
    expect(md).toContain("# Session Context: myproject");
  });

  it("shortens home directory to ~", () => {
    const md = toCompactMarkdown([sessionStart("/Users/alice/myproject")]);
    expect(md).toContain("~/myproject");
  });

  it("includes the model name", () => {
    const md = toCompactMarkdown([sessionStart("/tmp/proj", "claude-opus-4")]);
    expect(md).toContain("claude-opus-4");
  });

  it("includes a formatted date", () => {
    const md = toCompactMarkdown([sessionStart()]);
    expect(md).toContain("Mar");
    expect(md).toContain("2024");
  });
});

describe("toCompactMarkdown — requests section", () => {
  it("includes a Requests section with user messages", () => {
    const md = toCompactMarkdown([
      sessionStart(),
      userMsg("Fix the login bug"),
      userMsg("Add tests"),
    ]);
    expect(md).toContain("## Requests");
    expect(md).toContain("Fix the login bug");
    expect(md).toContain("Add tests");
  });

  it("numbers requests", () => {
    const md = toCompactMarkdown([sessionStart(), userMsg("First"), userMsg("Second")]);
    expect(md).toContain("1. First");
    expect(md).toContain("2. Second");
  });

  it("truncates user messages longer than 300 chars in the Requests list", () => {
    // Use 500 chars — Requests section shows max 300, Continue section shows max 400
    const longText = "x".repeat(500);
    const md = toCompactMarkdown([sessionStart(), userMsg(longText)]);
    expect(md).toContain("…");
    // Neither section should contain the full 500 chars
    expect(md).not.toContain("x".repeat(500));
  });

  it("omits Requests section when there are no user messages", () => {
    const md = toCompactMarkdown([sessionStart(), agentMsg("hello")]);
    expect(md).not.toContain("## Requests");
  });
});

describe("toCompactMarkdown — files changed section", () => {
  it("lists changed files", () => {
    const md = toCompactMarkdown([sessionStart(), fileChange("src/app.ts", "update")]);
    expect(md).toContain("## Files changed");
    expect(md).toContain("src/app.ts");
  });

  it("shows patch count when a file is changed multiple times", () => {
    const md = toCompactMarkdown([
      sessionStart(),
      fileChange("src/app.ts", "update"),
      fileChange("src/app.ts", "update"),
      fileChange("src/app.ts", "update"),
    ]);
    expect(md).toContain("(3 patches)");
  });

  it("does not show patch count for single-change files", () => {
    const md = toCompactMarkdown([sessionStart(), fileChange("src/app.ts", "add")]);
    expect(md).not.toContain("patches)");
  });

  it("includes a Patches section with diff blocks", () => {
    const md = toCompactMarkdown([sessionStart(), fileChange("src/app.ts", "update")]);
    expect(md).toContain("## Patches");
    expect(md).toContain("```diff");
  });

  it("omits Files changed section when there are no file changes", () => {
    const md = toCompactMarkdown([sessionStart(), userMsg("hello")]);
    expect(md).not.toContain("## Files changed");
  });
});

describe("toCompactMarkdown — commands section", () => {
  it("lists shell commands", () => {
    const md = toCompactMarkdown([sessionStart(), shellCmd("npm test")]);
    expect(md).toContain("## Commands run");
    expect(md).toContain("npm test");
  });

  it("includes workdir in # in comment when set", () => {
    const md = toCompactMarkdown([
      sessionStart(),
      shellCmd("pytest", "/Users/alice/myproject"),
    ]);
    expect(md).toContain("# in ~/myproject");
  });

  it("omits Commands section when there are no shell commands", () => {
    const md = toCompactMarkdown([sessionStart(), userMsg("hello")]);
    expect(md).not.toContain("## Commands run");
  });
});

describe("toCompactMarkdown — continue section", () => {
  it("includes the last user message in a Continue section", () => {
    const md = toCompactMarkdown([
      sessionStart(),
      userMsg("First request"),
      userMsg("Last request here"),
    ]);
    expect(md).toContain("## Continue from here");
    expect(md).toContain("Last request here");
  });

  it("omits Continue section with no user messages", () => {
    const md = toCompactMarkdown([sessionStart()]);
    expect(md).not.toContain("## Continue from here");
  });
});

describe("toCompactMarkdown — empty session", () => {
  it("returns a string without crashing on empty events", () => {
    const md = toCompactMarkdown([]);
    expect(typeof md).toBe("string");
  });
});
