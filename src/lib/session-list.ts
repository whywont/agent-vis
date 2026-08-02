import type { SessionMeta } from "./types";

export type SortBy = "newest" | "oldest" | "project";
export type SourceFilter = "all" | "claude" | "codex";

interface SessionFilterOptions {
  source: SourceFilter;
  search: string;
  contentMatches: Set<string> | null;
}

function activityTime(session: SessionMeta): number | null {
  for (const candidate of [session.modified, session.timestamp]) {
    if (!candidate) continue;
    const value = Date.parse(candidate);
    if (!Number.isNaN(value)) return value;
  }
  return null;
}

export function sessionFileKey(session: SessionMeta): string {
  return session.files ? session.files.join(",") : session.file;
}

export function filterSessions(
  sessions: SessionMeta[],
  options: SessionFilterOptions,
): SessionMeta[] {
  const query = options.search.toLowerCase();
  return sessions.filter((session) => {
    if (options.source === "claude" && session.source !== "claude-code") return false;
    if (options.source === "codex" && session.source === "claude-code") return false;
    if (!query) return true;

    const metadata = [session.cwd, session.project, session.id, session.file]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const refs = session.files ?? [session.file];
    const contentMatch = options.contentMatches !== null
      && refs.some((file) => options.contentMatches!.has(file));
    return metadata.includes(query) || contentMatch;
  });
}

export function sortSessions(sessions: SessionMeta[], sortBy: SortBy): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    if (sortBy === "newest" || sortBy === "oldest") {
      const leftTime = activityTime(left);
      const rightTime = activityTime(right);
      if (leftTime === null) return rightTime === null ? 0 : 1;
      if (rightTime === null) return -1;
      return sortBy === "newest" ? rightTime - leftTime : leftTime - rightTime;
    }
    const leftProject = left.project || left.cwd || "";
    const rightProject = right.project || right.cwd || "";
    return leftProject.localeCompare(rightProject);
  });
}
