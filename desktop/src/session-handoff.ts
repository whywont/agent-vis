import type { AppEvent, SessionMeta } from "@/lib/types";

const MAX_COMPACTION_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_FILES = 40;

function shorten(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n[truncated]`;
}

function latestText(events: AppEvent[], kind: "user_message" | "agent_message"): string | null {
  const event = [...events].reverse().find((item) => item.kind === kind);
  return event?.kind === kind && event.text.trim() ? shorten(event.text, MAX_MESSAGE_CHARS) : null;
}

export function continuationModel(session: SessionMeta): string {
  if (session.source === "claude-code") {
    return session.model.replace(/^claude:/, "") || "default";
  }
  // Older Codex records use `openai` as a source/provider label rather than
  // a model ID. Let the local Codex configuration select its valid default.
  return /^(?:openai|codex|default)$/i.test(session.model.trim()) ? "" : session.model;
}

export function buildSessionHandoff(session: SessionMeta, events: AppEvent[]): string {
  const compaction = [...events].reverse().find((event) => event.kind === "context_compaction");
  const changedFiles = [...new Set(events.flatMap((event) =>
    event.kind === "file_change" ? event.files.map((file) => file.path) : [],
  ))].slice(-MAX_FILES);
  const sections = [
    "Continue work from an imported Agent Vis transcript.",
    "This is a new local session, not the original process. Treat the selected workspace as authoritative: inspect its Git status, branch, and files before making changes. Do not assume source-machine paths, terminals, credentials, or uncommitted changes exist here.",
    `Source transcript: ${session.source} session ${session.id}; original workspace: ${session.cwd}; last activity: ${session.modified}.`,
  ];

  if (compaction?.kind === "context_compaction" && compaction.text.trim()) {
    sections.push(`Latest source compaction:\n${shorten(compaction.text, MAX_COMPACTION_CHARS)}`);
  }
  const request = latestText(events, "user_message");
  if (request) sections.push(`Most recent user request:\n${request}`);
  const response = latestText(events, "agent_message");
  if (response) sections.push(`Most recent agent response:\n${response}`);
  if (changedFiles.length) sections.push(`Files changed in the source transcript:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`);
  sections.push("First, verify the local checkout is the intended repository and summarize any mismatch before continuing the task.");
  return sections.join("\n\n");
}
