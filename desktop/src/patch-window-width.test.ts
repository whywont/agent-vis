import { describe, expect, it } from "vitest";
import { constrainedPatchWindowWidth, expandedPatchWindowWidth } from "./patch-window-width";

describe("expanded patch window width", () => {
  it("requests no expansion when the patch already fits", () => {
    expect(expandedPatchWindowWidth(1400, 1000, 1100)).toBe(0);
  });

  it("adds the entire hidden line width plus breathing room", () => {
    expect(expandedPatchWindowWidth(1400, 1900, 1100)).toBe(2232);
  });

  it("caps an expansion at the usable screen edge without shrinking the original window", () => {
    expect(constrainedPatchWindowWidth(1400, 2232, 1680)).toBe(1680);
    expect(constrainedPatchWindowWidth(1800, 2232, 1680)).toBe(1800);
  });
});
