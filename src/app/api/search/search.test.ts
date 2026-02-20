import { describe, it, expect } from "vitest";
import { eventSearchText } from "@/lib/search-utils";
import type { AppEvent } from "@/lib/types";

const TS = "2024-06-01T10:00:00Z";

function make(kind: string, extra: Record<string, unknown> = {}): AppEvent {
  return { kind, ts: TS, ...extra } as AppEvent;
}

describe("eventSearchText — included event kinds", () => {
  it("includes user message text", () => {
    const text = eventSearchText([make("user_message", { text: "Fix the login bug" })]);
    expect(text).toContain("fix the login bug");
  });

  it("includes agent message text", () => {
    const text = eventSearchText([make("agent_message", { text: "Done, I updated the handler" })]);
    expect(text).toContain("updated the handler");
  });

  it("includes reasoning text", () => {
    const text = eventSearchText([make("reasoning", { text: "I should refactor this" })]);
    expect(text).toContain("refactor");
  });

  it("includes file paths from file_change events", () => {
    const text = eventSearchText([
      make("file_change", {
        patch: "",
        files: [{ action: "update", path: "src/auth/login.ts" }],
      }),
    ]);
    expect(text).toContain("src/auth/login.ts");
  });

  it("includes patch content from file_change", () => {
    const text = eventSearchText([
      make("file_change", {
        patch: "function handleLogin()",
        files: [],
      }),
    ]);
    expect(text).toContain("handlelogin");
  });

  it("includes shell command text", () => {
    const text = eventSearchText([make("shell_command", { cmd: "npm run build", workdir: "" })]);
    expect(text).toContain("npm run build");
  });
});

describe("eventSearchText — excluded event kinds", () => {
  it("does not include tool_output", () => {
    const text = eventSearchText([make("tool_output", { output: "secret_tool_output_xyz" })]);
    expect(text).not.toContain("secret_tool_output_xyz");
  });

  it("does not include token_usage", () => {
    const text = eventSearchText([
      make("token_usage", {
        total_input: 1000,
        cached_input: 0,
        total_output: 500,
        reasoning_output: 0,
        total_tokens: 1500,
        context_window: 8192,
        last_input: 100,
        last_output: 50,
      }),
    ]);
    // token_usage has no text fields, result should be empty
    expect(text.trim()).toBe("");
  });

  it("does not include session_start metadata", () => {
    const text = eventSearchText([
      make("session_start", { id: "sess-secret-123", cwd: "/secret/path", model: "claude" }),
    ]);
    expect(text).not.toContain("sess-secret-123");
    expect(text).not.toContain("/secret/path");
  });
});

describe("eventSearchText — output is lowercased", () => {
  it("lowercases all text for case-insensitive search", () => {
    const text = eventSearchText([make("user_message", { text: "Fix Flask App" })]);
    expect(text).toBe("fix flask app");
  });
});

describe("eventSearchText — multiple events joined", () => {
  it("combines text from multiple events", () => {
    const events: AppEvent[] = [
      make("user_message", { text: "build the API" }),
      make("agent_message", { text: "Creating endpoint" }),
      make("shell_command", { cmd: "npm test", workdir: "" }),
    ];
    const text = eventSearchText(events);
    expect(text).toContain("build the api");
    expect(text).toContain("creating endpoint");
    expect(text).toContain("npm test");
  });

  it("returns empty string for empty event list", () => {
    expect(eventSearchText([])).toBe("");
  });
});
