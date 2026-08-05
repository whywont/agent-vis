import { describe, expect, it } from "vitest";
import { formatStructuredList, getHarnessAdapter } from "./harness-adapters";

describe("harness adapters", () => {
  it("declares a provider-specific command catalog behind one interface", () => {
    expect(getHarnessAdapter("codex").initialCommands.map((command) => command.id)).toContain("skills");
    expect(getHarnessAdapter("claude-code").initialCommands.map((command) => command.id)).toContain("model");
  });

  it("formats nested structured skill data without dumping JSON", () => {
    expect(formatStructuredList({
      data: [{
        cwd: "/repo",
        skills: [{ name: "skill-creator", description: "Create or update a skill", enabled: true }],
      }],
    }, "skills")).toBe("Skills:\n- skill-creator - Create or update a skill (enabled)");
  });
});
