import type { SessionMeta } from "./types";
import { sessionFileKey } from "./session-list";

export type SessionExportFormat = "json" | "compact";

export interface SessionExportDescriptor {
  href: string;
  filename: string;
}

export function sessionExportDescriptor(
  session: SessionMeta,
  format: SessionExportFormat,
): SessionExportDescriptor {
  const fileKey = encodeURIComponent(sessionFileKey(session));
  const shortId = session.id.slice(0, 12);
  if (format === "compact") {
    return {
      href: `/api/session-compact/${fileKey}`,
      filename: `context-${shortId}.md`,
    };
  }
  return {
    href: `/api/session/${fileKey}`,
    filename: `session-${shortId}.json`,
  };
}
