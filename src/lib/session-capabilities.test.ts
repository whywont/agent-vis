import { describe, expect, it } from "vitest";
import { claudeInitCapabilities, createTokenAccumulator, parseClaudeEvent } from "./claude-parser";
import { summarizeCapabilities } from "./session-capabilities";
import type { AppEvent } from "./types";

const TS = "2026-10-05T10:00:00.000Z";

function parse(attachment: Record<string, unknown>): AppEvent[] {
  return parseClaudeEvent({ type: "attachment", timestamp: TS, attachment }, createTokenAccumulator());
}

describe("Claude capability attachments", () => {
  const events = [
    ...parse({ type: "prompt_snapshot", tools: [{ name: "Bash", description: "", schema: {} }, { name: "Read" }] }),
    ...parse({
      type: "deferred_tools_delta",
      addedNames: [
        "WebFetch",
        "mcp__Neon__run_sql",
        "mcp__Neon__list_projects",
        "mcp__claude_ai_Slack__slack_send_message",
        "mcp__claude_ai_Gmail__authenticate",
        "mcp__claude_ai_Gmail__complete_authentication",
      ],
      removedNames: [],
      failedMcpServers: ["broken"],
      pendingMcpServers: [],
      needsAuthMcpServers: null,
    }),
    ...parse({ type: "skill_listing", isInitial: true, names: ["dataviz", "codex:rescue"], skillCount: 2 }),
    ...parse({ type: "agent_listing_delta", addedTypes: ["Explore", "codex:codex-rescue"], removedTypes: [] }),
    ...parse({ type: "date", date: "2026-10-05" }),
    { kind: "tool_call", ts: TS, toolName: "mcp__Neon__run_sql", text: "" },
    { kind: "tool_call", ts: TS, toolName: "mcp__Neon__run_sql", text: "" },
    { kind: "shell_command", ts: TS, toolName: "Bash", cmd: "ls", workdir: "/" },
  ] satisfies AppEvent[];
  const summary = summarizeCapabilities(events);

  it("only turns capability attachments into events", () => {
    expect(events.filter((event) => event.kind === "capabilities")).toHaveLength(4);
  });

  it("separates loaded and on-demand built-in tools", () => {
    expect(summary.builtinTools).toEqual([
      { name: "Bash", onDemand: false },
      { name: "Read", onDemand: false },
      { name: "WebFetch", onDemand: true },
    ]);
  });

  it("groups MCP tools by server with a status", () => {
    expect(summary.mcpServers.map(({ id, label, origin, status, tools }) => ({ id, label, origin, status, tools: tools.length }))).toEqual([
      { id: "Neon", label: "Neon", origin: "local", status: "connected", tools: 2 },
      { id: "claude_ai_Slack", label: "Slack", origin: "connector", status: "connected", tools: 1 },
      { id: "broken", label: "broken", origin: "local", status: "failed", tools: 0 },
      { id: "claude_ai_Gmail", label: "Gmail", origin: "connector", status: "needs_auth", tools: 2 },
    ]);
  });

  it("lists skills, agents, and the plugins they come from", () => {
    expect(summary.skills).toEqual(["codex:rescue", "dataviz"]);
    expect(summary.agents).toEqual(["Explore", "codex:codex-rescue"]);
    expect(summary.plugins).toEqual(["codex"]);
  });

  it("counts the tools that actually ran", () => {
    expect(summary.hasInventory).toBe(true);
    expect(summary.toolsUsed).toEqual([{ name: "mcp__Neon__run_sql", count: 2 }, { name: "Bash", count: 1 }]);
  });
});

describe("summarizeCapabilities", () => {
  it("reports only tools used when nothing was recorded", () => {
    const summary = summarizeCapabilities([{ kind: "shell_command", ts: TS, toolName: "exec_command", cmd: "ls", workdir: "/" }]);
    expect(summary.hasInventory).toBe(false);
    expect(summary.toolsUsed).toEqual([{ name: "exec_command", count: 1 }]);
  });

  it("matches live server display names to their tools", () => {
    const init = claudeInitCapabilities({
      type: "system",
      subtype: "init",
      tools: ["Bash", "mcp__claude_ai_Slack__slack_send_message"],
      mcp_servers: [{ name: "claude.ai Slack", status: "connected" }, { name: "claude.ai Gmail", status: "needs-auth" }],
      skills: ["dataviz"],
      agents: ["Explore"],
      plugins: [{ name: "codex", path: "/plugins/codex" }],
    }, TS);
    expect(init).not.toBeNull();
    const summary = summarizeCapabilities([init!]);
    expect(summary.mcpServers.map(({ label, status }) => [label, status])).toEqual([["Slack", "connected"], ["Gmail", "needs_auth"]]);
    expect(summary.plugins).toEqual(["codex"]);
  });

  it("ignores frames that are not init", () => {
    expect(claudeInitCapabilities({ type: "system", subtype: "status" }, TS)).toBeNull();
  });
});
