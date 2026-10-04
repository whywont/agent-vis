import { describe, expect, it } from "vitest";
import { explainRequestParams, thinksByDefault, THINKING_HEADROOM_TOKENS } from "./anthropic-explain";

describe("thinksByDefault", () => {
  it("flags models that think unless told otherwise", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
      expect(thinksByDefault(model)).toBe(true);
    }
  });

  it("leaves older models alone", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-4-20250514", "qwen3:8b"]) {
      expect(thinksByDefault(model)).toBe(false);
    }
  });
});

describe("explainRequestParams", () => {
  it("adds low effort and thinking headroom for thinking models", () => {
    expect(explainRequestParams("claude-opus-5-5", 512)).toEqual({
      max_tokens: 512 + THINKING_HEADROOM_TOKENS,
      output_config: { effort: "low" },
    });
  });

  it("keeps the plain budget for Haiku", () => {
    expect(explainRequestParams("claude-haiku-4-5", 512)).toEqual({ max_tokens: 512 });
  });
});
