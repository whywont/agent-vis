import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/types";
import { descendantSessions, subagentChildren, subagentLabel, topLevelSessions } from "./subagent-sessions";

function session(id: string, parentSessionId?: string): SessionMeta {
  return {
    file: `${id}.jsonl`, id, parentSessionId, cwd: "/repo", model: "openai",
    timestamp: "2026-08-08T00:00:00Z", modified: "2026-08-08T00:00:00Z",
    cli_version: "1", source: "codex",
  };
}

describe("sub-agent session hierarchy", () => {
  it("nests attached children while preserving orphaned rollouts at the top level", () => {
    const parent = session("parent");
    const child = session("child", "parent");
    const orphan = session("orphan", "missing");
    expect(topLevelSessions([parent, child, orphan]).map((item) => item.id)).toEqual(["parent", "orphan"]);
  });

  it("supports arbitrary descendant depth", () => {
    const sessions = [session("parent"), session("child", "parent"), session("grandchild", "child")];
    expect(descendantSessions("parent", subagentChildren(sessions)).map((item) => item.id))
      .toEqual(["child", "grandchild"]);
  });

  it("prefers nickname, then agent path, then the thread id", () => {
    expect(subagentLabel({ ...session("child"), agentNickname: "Linnaeus", agentPath: "/root/reviewer" })).toBe("Linnaeus");
    expect(subagentLabel({ ...session("child"), agentPath: "/root/reviewer" })).toBe("reviewer");
    expect(subagentLabel(session("019fdf87-35dd"))).toBe("019fdf87-35d");
  });
});
