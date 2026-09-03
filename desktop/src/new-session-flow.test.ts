import { describe, expect, it } from "vitest";
import { previousNewSessionSelection } from "./new-session-flow";

describe("previousNewSessionSelection", () => {
  it("returns from workspace selection to reasoning effort", () => {
    expect(previousNewSessionSelection({ provider: "codex", model: "gpt-5", effort: "high" })).toEqual({
      provider: "codex",
      model: "gpt-5",
      effort: null,
    });
  });

  it("returns from reasoning effort to model selection", () => {
    expect(previousNewSessionSelection({ provider: "codex", model: "gpt-5", effort: null })).toEqual({
      provider: "codex",
      model: null,
      effort: null,
    });
  });

  it("returns from model selection to harness selection", () => {
    expect(previousNewSessionSelection({ provider: "claude-code", model: null, effort: null })).toEqual({
      provider: null,
      model: null,
      effort: null,
    });
  });
});
