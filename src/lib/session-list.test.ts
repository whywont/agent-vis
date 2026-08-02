import { describe, expect, it } from "vitest";
import { filterSessions, sessionFileKey, sortSessions } from "./session-list";
import type { SessionMeta } from "./types";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    file: "session.jsonl",
    id: "session-id",
    cwd: "/Users/alice/project",
    model: "claude",
    timestamp: "2026-07-01T12:00:00.000Z",
    modified: "2026-07-01T12:00:00.000Z",
    cli_version: "1.0.0",
    source: "claude-code",
    ...overrides,
  };
}

describe("sortSessions", () => {
  const older = session({ id: "older", modified: "2026-07-01T12:00:00.000Z" });
  const newer = session({ id: "newer", modified: "2026-07-03T12:00:00.000Z" });

  it("sorts newest sessions first using modified activity time", () => {
    expect(sortSessions([older, newer], "newest").map((item) => item.id))
      .toEqual(["newer", "older"]);
  });

  it("sorts oldest sessions first", () => {
    expect(sortSessions([newer, older], "oldest").map((item) => item.id))
      .toEqual(["older", "newer"]);
  });

  it("falls back to the session timestamp when modified is empty or invalid", () => {
    const timestampOnly = session({
      id: "timestamp-only",
      modified: "not-a-date",
      timestamp: "2026-07-04T12:00:00.000Z",
    });
    expect(sortSessions([older, timestampOnly], "newest")[0].id).toBe("timestamp-only");
  });

  it("places sessions with no valid activity date last in either date order", () => {
    const invalid = session({ id: "invalid", modified: "not-a-date", timestamp: "" });
    expect(sortSessions([invalid, older], "newest").at(-1)?.id).toBe("invalid");
    expect(sortSessions([invalid, older], "oldest").at(-1)?.id).toBe("invalid");
  });

  it("sorts by project label", () => {
    const zeta = session({ id: "zeta", project: "zeta" });
    const alpha = session({ id: "alpha", project: "alpha" });
    expect(sortSessions([zeta, alpha], "project").map((item) => item.id))
      .toEqual(["alpha", "zeta"]);
  });
});

describe("filterSessions", () => {
  const claude = session({ file: "claude:project/a.jsonl", id: "claude-one" });
  const codex = session({ file: "codex.jsonl", id: "codex-one", source: "codex" });

  it("filters sessions by provider", () => {
    expect(filterSessions([claude, codex], {
      source: "codex",
      search: "",
      contentMatches: null,
    })).toEqual([codex]);
  });

  it("searches project and working-directory metadata case-insensitively", () => {
    const finance = session({ project: "Finance-App", cwd: "/Users/alice/finance" });
    expect(filterSessions([finance, codex], {
      source: "all",
      search: "FINANCE",
      contentMatches: null,
    })).toEqual([finance]);
  });

  it("includes grouped sessions when any backing file has a content match", () => {
    const grouped = session({ files: ["one.jsonl", "two.jsonl"] });
    expect(filterSessions([grouped], {
      source: "all",
      search: "needle",
      contentMatches: new Set(["two.jsonl"]),
    })).toEqual([grouped]);
  });
});

describe("sessionFileKey", () => {
  it("uses all grouped file references as the stable key", () => {
    expect(sessionFileKey(session({ files: ["one", "two"] }))).toBe("one,two");
  });
});
