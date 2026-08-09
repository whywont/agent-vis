import type { FileChangeEvent } from "@/lib/types";
import { buildImportEdges, groupFileChanges } from "./files-canvas-utils";

export type TestingEvidence = "imported" | "inferred";

export interface TestingNode {
  path: string;
  filename: string;
  directory: string;
  changes: number;
  additions: number;
  action: "add" | "update" | "delete";
  attribution: "tool_confirmed" | "request_derived" | "legacy";
  patches: Array<{ ts: string; patch: string }>;
}

export interface TestingEdge {
  testPath: string;
  codePath: string;
  evidence: TestingEvidence;
  label: string;
}

export interface TestingGraph {
  code: TestingNode[];
  tests: TestingNode[];
  edges: TestingEdge[];
  untested: string[];
}

const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

export function buildTestingGraph(fileChanges: FileChangeEvent[], sessionCwd: string): TestingGraph {
  const groups = groupFileChanges(fileChanges, sessionCwd);
  const files = groups.flatMap((group) => group.files);
  const nodes = new Map(files.map((file) => [file.path, testingNode(file.path, file.changes, sessionCwd)]));
  const tests = [...nodes.values()].filter((node) => isTestPath(node.path));
  const code = [...nodes.values()].filter((node) => !isTestPath(node.path));
  const codePaths = new Set(code.map((node) => node.path));
  const edges: TestingEdge[] = [];
  const seen = new Set<string>();

  for (const edge of buildImportEdges(groups)) {
    if (!isTestPath(edge.from) || !codePaths.has(edge.to)) continue;
    addEdge(edges, seen, {
      testPath: edge.from,
      codePath: edge.to,
      evidence: "imported",
      label: edge.label || "direct import",
    });
  }

  for (const test of tests) {
    const testName = comparableStem(test.path);
    if (!testName) continue;
    for (const source of code) {
      if (comparableStem(source.path) !== testName) continue;
      addEdge(edges, seen, {
        testPath: test.path,
        codePath: source.path,
        evidence: "inferred",
        label: "matching filename",
      });
    }
  }

  const exercised = new Set(edges.map((edge) => edge.codePath));
  const linkedTests = new Set(edges.map((edge) => edge.testPath));
  return {
    code: sortLinkedFirst(code, exercised),
    tests: sortLinkedFirst(tests, linkedTests),
    edges,
    untested: code.filter((node) => !exercised.has(node.path)).map((node) => node.path),
  };
}

function sortLinkedFirst(nodes: TestingNode[], linkedPaths: Set<string>): TestingNode[] {
  return nodes.sort((left, right) => {
    const linkOrder = Number(linkedPaths.has(right.path)) - Number(linkedPaths.has(left.path));
    return linkOrder || left.path.localeCompare(right.path);
  });
}

function testingNode(path: string, changes: FileChangeEvent[], sessionCwd: string): TestingNode {
  const latest = changes.at(-1);
  const file = latest?.files.find((entry) => normalizePath(entry.path, sessionCwd) === path);
  const parts = path.split("/");
  return {
    path,
    filename: parts.at(-1) || path,
    directory: parts.length > 1 ? parts.slice(0, -1).join("/") : ".",
    changes: changes.length,
    additions: changes.reduce((total, change) => total + addedLines(change.patch), 0),
    action: file?.action ?? "update",
    attribution: changes.some((change) => change.attribution === "tool_completed")
      ? "tool_confirmed"
      : changes.some((change) => change.attribution === "tool_requested")
        ? "request_derived"
        : "legacy",
    patches: changes.flatMap((change) => {
      const patch = patchForFile(change.patch, path, sessionCwd);
      return patch ? [{ ts: change.ts, patch }] : [];
    }),
  };
}

export function patchForFile(patch: string, filepath: string, sessionCwd: string): string {
  const lines = patch.split("\n");
  const output: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      collecting = normalizePath(header[2].trim(), sessionCwd) === filepath;
      if (collecting) output.push("*** Begin Patch", line);
      continue;
    }
    if (collecting && line === "*** End Patch") {
      output.push(line);
      collecting = false;
      continue;
    }
    if (collecting) output.push(line);
  }
  if (output.length && output.at(-1) !== "*** End Patch") output.push("*** End Patch");
  return output.join("\n");
}

function normalizePath(path: string, sessionCwd: string): string {
  const root = sessionCwd.replace(/\/$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function addedLines(patch: string): number {
  return patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
}

function comparableStem(path: string): string {
  const filename = path.split("/").at(-1) || path;
  return filename
    .replace(/\.(test|spec)(?=\.)/i, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_.]/g, "")
    .toLowerCase();
}

function addEdge(edges: TestingEdge[], seen: Set<string>, edge: TestingEdge) {
  const key = `${edge.testPath}->${edge.codePath}`;
  if (seen.has(key)) {
    const existing = edges.find((candidate) => `${candidate.testPath}->${candidate.codePath}` === key);
    if (existing?.evidence === "inferred" && edge.evidence === "imported") Object.assign(existing, edge);
    return;
  }
  seen.add(key);
  edges.push(edge);
}
