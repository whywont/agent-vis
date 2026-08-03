import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "./request-origin";

describe("isSameOriginRequest", () => {
  it("allows matching origins including the served port", () => {
    expect(isSameOriginRequest("127.0.0.1:3333", "http://127.0.0.1:3333", null)).toBe(true);
  });

  it("blocks cross-origin browser requests", () => {
    expect(isSameOriginRequest("127.0.0.1:3333", "https://evil.example", null)).toBe(false);
  });

  it("falls back to the referer when Origin is absent", () => {
    expect(isSameOriginRequest("agent-vis.local", null, "https://agent-vis.local/settings"))
      .toBe(true);
  });

  it("allows non-browser clients with neither header", () => {
    expect(isSameOriginRequest("127.0.0.1:3333", null, null)).toBe(true);
  });

  it("rejects malformed origins and missing Host headers", () => {
    expect(isSameOriginRequest("127.0.0.1:3333", "not a url", null)).toBe(false);
    expect(isSameOriginRequest(null, "http://127.0.0.1:3333", null)).toBe(false);
  });
});
