import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { isInsideDir, resolveExistingPathInsideDirs } from "./path-safety";
import {
  CLAUDE_PROJECTS_DIR,
  CODEX_SESSIONS_DIR,
  resolveSessionFile,
} from "./server-utils";

describe("isInsideDir", () => {
  const root = path.join(path.sep, "Users", "alice", "project");

  it("allows the root and descendants", () => {
    expect(isInsideDir(root, root)).toBe(true);
    expect(isInsideDir(path.join(root, "src", "app.ts"), root)).toBe(true);
  });

  it("blocks traversal and similarly prefixed sibling directories", () => {
    expect(isInsideDir(path.join(root, "..", "secret.txt"), root)).toBe(false);
    expect(isInsideDir(`${root}-private/secret.txt`, root)).toBe(false);
  });
});

describe("resolveExistingPathInsideDirs", () => {
  it("rejects a symlink that escapes an allowed root", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-vis-path-safety-"));
    const allowed = path.join(directory, "allowed");
    const outside = path.join(directory, "outside.txt");
    fs.mkdirSync(allowed);
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(allowed, "link.txt"));

    expect(resolveExistingPathInsideDirs(path.join(allowed, "link.txt"), [allowed])).toBeNull();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("returns the canonical path for an allowed existing file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-vis-path-safety-"));
    const file = path.join(directory, "file.txt");
    fs.writeFileSync(file, "safe");

    expect(resolveExistingPathInsideDirs(file, [directory])).toBe(fs.realpathSync.native(file));
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("resolveSessionFile", () => {
  it("keeps valid Claude and Codex references within their session roots", () => {
    expect(isInsideDir(resolveSessionFile("claude:project/session.jsonl").filepath, CLAUDE_PROJECTS_DIR))
      .toBe(true);
    expect(isInsideDir(resolveSessionFile("2026/session.jsonl").filepath, CODEX_SESSIONS_DIR))
      .toBe(true);
  });

  it("maps traversal attempts to a harmless sentinel inside the root", () => {
    const claude = resolveSessionFile("claude:../../.ssh/id_rsa");
    const codex = resolveSessionFile("../../.ssh/id_rsa");
    expect(claude.filepath).toBe(path.join(CLAUDE_PROJECTS_DIR, ".__agentvis_invalid__"));
    expect(codex.filepath).toBe(path.join(CODEX_SESSIONS_DIR, ".__agentvis_invalid__"));
  });
});
