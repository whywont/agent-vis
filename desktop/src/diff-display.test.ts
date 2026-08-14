import { describe, expect, it } from "vitest";
import { OVERSIZED_DIFF_CONTEXT_LENGTH, shouldCompactDiffContextLine } from "./diff-display";

describe("shouldCompactDiffContextLine", () => {
  it("compacts a minified unchanged line", () => {
    expect(shouldCompactDiffContextLine("context", "x".repeat(OVERSIZED_DIFF_CONTEXT_LENGTH + 1))).toBe(true);
  });

  it("never compacts actual changes", () => {
    const longLine = "x".repeat(OVERSIZED_DIFF_CONTEXT_LENGTH + 1);
    expect(shouldCompactDiffContextLine("added", longLine)).toBe(false);
    expect(shouldCompactDiffContextLine("removed", longLine)).toBe(false);
  });

  it("leaves ordinary context visible", () => {
    expect(shouldCompactDiffContextLine("context", "const unchanged = true;")).toBe(false);
  });
});
