import { describe, expect, it } from "vitest";
import { formatStructuredList, getHarnessAdapter } from "./harness-adapters";

describe("harness adapters", () => {
  it("declares a provider-specific command catalog behind one interface", () => {
    expect(getHarnessAdapter("codex").initialCommands.map((command) => command.id)).toContain("skills");
    expect(getHarnessAdapter("claude-code").initialCommands.map((command) => command.id)).toContain("model");
  });

  it("exposes interactive requests as an optional provider bridge", () => {
    const codex = getHarnessAdapter("codex");
    const claude = getHarnessAdapter("claude-code");
    expect(claude.interactiveRequests).toBeUndefined();
    expect(codex.interactiveRequests?.decode({
      jsonrpc: "2.0",
      id: "approval-7",
      method: "item/commandExecution/requestApproval",
      params: { command: "cargo check" },
    })).toMatchObject({
      type: "approval",
      requestId: "approval-7",
      command: "cargo check",
    });
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
