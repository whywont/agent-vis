import { describe, expect, it } from "vitest";
import { expandedPatchWindowWidth } from "./patch-window-width";

describe("expanded patch window width", () => {
  it("requests no expansion when the patch already fits", () => {
    expect(expandedPatchWindowWidth(1400, 1000, 1100)).toBe(0);
  });

  it("adds the entire hidden line width plus breathing room", () => {
    expect(expandedPatchWindowWidth(1400, 1900, 1100)).toBe(2232);
  });
});
