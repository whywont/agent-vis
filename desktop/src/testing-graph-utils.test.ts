import { describe, expect, it } from "vitest";
import type { FileChangeEvent } from "@/lib/types";
import { buildTestingGraph, isTestPath, patchForFile } from "./testing-graph-utils";

function change(path: string, patch = "", action: "add" | "update" | "delete" = "update", attribution: FileChangeEvent["attribution"] = "tool_completed"): FileChangeEvent {
  return { kind: "file_change", ts: "2026-08-07T00:00:00Z", patch, files: [{ path, action }], attribution };
}

describe("session testing graph", () => {
  it("recognizes common test file conventions", () => {
    expect(isTestPath("src/auth.test.ts")).toBe(true);
    expect(isTestPath("tests/auth.py")).toBe(true);
    expect(isTestPath("src/__tests__/auth.ts")).toBe(true);
    expect(isTestPath("src/contest.ts")).toBe(false);
  });

  it("links a session test to session code through a direct import", () => {
    const graph = buildTestingGraph([
      change("src/auth.ts", "+export function authenticate() {}"),
      change("src/auth.test.ts", "+import { authenticate } from './auth';"),
    ], "");

    expect(graph.edges).toEqual([{
      testPath: "src/auth.test.ts",
      codePath: "src/auth.ts",
      evidence: "imported",
      label: "{ authenticate }",
    }]);
    expect(graph.untested).toEqual([]);
  });

  it("uses filename evidence and keeps unrelated session code visible", () => {
    const graph = buildTestingGraph([
      change("src/auth.ts"),
      change("src/cache.ts"),
      change("tests/auth.spec.ts"),
    ], "");

    expect(graph.edges[0]).toMatchObject({
      testPath: "tests/auth.spec.ts",
      codePath: "src/auth.ts",
      evidence: "inferred",
    });
    expect(graph.untested).toEqual(["src/cache.ts"]);
  });

  it("keeps analysis scoped to files changed in the session", () => {
    const graph = buildTestingGraph([
      change("/repo/src/auth.ts"),
      change("/repo/tests/auth.test.ts", "+import '../src/auth';"),
    ], "/repo");

    expect(graph.code.map((node) => node.path)).toEqual(["src/auth.ts"]);
    expect(graph.tests.map((node) => node.path)).toEqual(["tests/auth.test.ts"]);
  });

  it("exposes whether a transcript change was tool-confirmed or request-derived", () => {
    const graph = buildTestingGraph([
      change("src/confirmed.ts"),
      change("src/requested.ts", "", "update", "tool_requested"),
    ], "");

    expect(graph.code.map((node) => [node.path, node.attribution])).toEqual([
      ["src/confirmed.ts", "tool_confirmed"],
      ["src/requested.ts", "request_derived"],
    ]);
  });

  it("orders linked code and tests before unlinked session changes", () => {
    const graph = buildTestingGraph([
      change("src/a-unlinked.ts"),
      change("src/z-linked.ts"),
      change("src/a-orphan.test.ts"),
      change("src/z-linked.test.ts", "+import { linked } from './z-linked';"),
    ], "");

    expect(graph.code.map((node) => node.path)).toEqual([
      "src/z-linked.ts",
      "src/a-unlinked.ts",
    ]);
    expect(graph.tests.map((node) => node.path)).toEqual([
      "src/z-linked.test.ts",
      "src/a-orphan.test.ts",
    ]);
  });

  it("extracts only the selected file from a multi-file session patch", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /repo/src/a.ts",
      "-old a",
      "+new a",
      "*** Update File: /repo/src/b.ts",
      "-old b",
      "+new b",
      "*** End Patch",
    ].join("\n");

    expect(patchForFile(patch, "src/b.ts", "/repo")).toBe([
      "*** Begin Patch",
      "*** Update File: /repo/src/b.ts",
      "-old b",
      "+new b",
      "*** End Patch",
    ].join("\n"));
  });
});
