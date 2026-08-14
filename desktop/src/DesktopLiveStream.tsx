import { useEffect, useRef } from "react";
import { formatTime } from "@/utils/format";
import type { AppEvent } from "@/lib/types";
import { workspaceRelativePath } from "./workspace-path";

export type LiveStreamEntry = {
  id: string;
  ts: string;
  kind: "input" | "assistant" | "reasoning" | "tool" | "output" | "system";
  text: string;
  append?: boolean;
};

const labels: Record<LiveStreamEntry["kind"], string> = {
  input: "You",
  assistant: "Agent",
  reasoning: "Thinking",
  tool: "Tool",
  output: "Output",
  system: "Status",
};

export default function DesktopLiveStream({
  entries,
  events,
  sessionCwd,
  branch,
  branchCopied,
  onCopyBranch,
}: {
  entries: LiveStreamEntry[];
  events: AppEvent[];
  sessionCwd: string;
  branch: string | null;
  branchCopied: boolean;
  onCopyBranch: () => void;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  const currentState = currentSessionState(entries);
  const latestTool = latestRequestTool(entries, events);
  const changedFiles = changedRequestFiles(entries, events, sessionCwd);
  const usage = latestUsage(events);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [entries]);

  return <>
    <div className="desktop-live-stream" aria-label="Live agent stream" ref={streamRef}>
      {entries.length ? entries.map((entry) => (
        <div className={`desktop-live-stream-line kind-${entry.kind}`} key={entry.id}>
          <b><span>{labels[entry.kind]}</span><time>{formatTime(entry.ts)}</time></b>
          <pre title={entry.kind === "tool" ? entry.text : undefined}>{entry.kind === "tool" ? shortToolCall(entry.text) : entry.text}</pre>
        </div>
      )) : <div className="desktop-live-stream-empty">Live bridge output appears here.</div>}
    </div>
    <aside className="desktop-current-session" aria-label="Current request">
      <header>Current request</header>
      <div className={`desktop-current-session-state is-${currentState.toLowerCase()}`}><i aria-hidden="true" />{currentState}</div>
      {latestTool && <div className="desktop-current-session-row"><span>Latest tool</span><code>{latestTool}</code></div>}
      <div className="desktop-current-session-row">
        <span>Files touched</span>
        {changedFiles.length ? <ul>{changedFiles.map((file) => <li key={file}>{file}</li>)}</ul> : <em>None yet</em>}
      </div>
      {usage && <div className="desktop-current-session-row desktop-current-session-usage">
        <span>Context</span>
        <div><b style={{ width: `${Math.min(100, usage.percent)}%` }} /></div>
        <em>{usage.used.toLocaleString()} / {usage.limit.toLocaleString()} tokens</em>
      </div>}
      {branch && <button
        type="button"
        className="desktop-current-session-branch desktop-file-branch-row"
        title={`Copy branch name: ${branch}`}
        aria-label={`Copy branch name: ${branch}`}
        onClick={onCopyBranch}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
        </svg>
        <code>{branch}</code>
        {branchCopied && <small role="status">Branch copied</small>}
      </button>}
    </aside>
  </>;
}

function shortToolCall(text: string): string {
  const lines = text.split("\n");
  const firstTwoLines = lines.slice(0, 2);
  const maxCharacters = 180;
  const visible = firstTwoLines.join("\n");
  if (lines.length <= 2 && visible.length <= maxCharacters) return visible;
  return `${visible.slice(0, maxCharacters - 1).trimEnd()}...`;
}

function currentSessionState(entries: LiveStreamEntry[]): "Working" | "Idle" | "Stopped" {
  const status = [...entries].reverse().find((entry) => entry.kind === "system")?.text.toLowerCase() || "";
  if (status.includes("working")) return "Working";
  if (status.includes("stopped") || status.includes("failed")) return "Stopped";
  return "Idle";
}

function latestRequestTool(entries: LiveStreamEntry[], events: AppEvent[]): string | null {
  // Live bridge frames arrive before the JSONL reader sees them. Once a
  // transcript is loaded, use its tool history instead of retaining a tool
  // from whichever session happened to stream most recently.
  const latestInput = [...entries].reverse().find((entry) => entry.kind === "input")?.ts;
  const latestUserMessage = [...events].reverse().find((event) => event.kind === "user_message")?.ts;
  const requestStartedAt = latestInput || latestUserMessage;
  const fromTranscript = [...events].reverse().find((event) => (event.kind === "shell_command" || event.kind === "tool_call")
    && (!requestStartedAt || Date.parse(event.ts) >= Date.parse(requestStartedAt)));
  if (fromTranscript?.kind === "shell_command") return fromTranscript.cmd.replace(/^\$\s*/, "");
  if (fromTranscript?.kind === "tool_call") return fromTranscript.text;
  return [...entries].reverse().find((entry) => entry.kind === "tool")?.text.replace(/^\$\s*/, "") || null;
}

function changedRequestFiles(
  entries: LiveStreamEntry[],
  events: AppEvent[],
  sessionCwd: string,
): string[] {
  // The live input is the most precise boundary for this request. Persisted
  // user messages cover requests sent before the bridge connected.
  const liveRequest = [...entries].reverse().find((entry) => entry.kind === "input")?.ts;
  const persistedRequest = [...events].reverse().find((event) => event.kind === "user_message")?.ts;
  const requestStartedAt = liveRequest || persistedRequest;
  const files = new Set<string>();
  for (const event of events) if (event.kind === "file_change"
    && (!requestStartedAt || Date.parse(event.ts) >= Date.parse(requestStartedAt))) {
    event.files.forEach((file) => files.add(workspaceRelativePath(file.path, sessionCwd)));
  }
  return [...files].slice(-5);
}

function latestUsage(events: AppEvent[]): { used: number; limit: number; percent: number } | null {
  const event = [...events].reverse().find((candidate) => candidate.kind === "token_usage");
  if (!event || event.kind !== "token_usage" || !event.context_window) return null;
  // Codex's aggregate total includes cache reads. The meter is meant to show
  // fresh context consumption, so deliberately exclude cached input here.
  const used = Math.max(0, event.total_input - event.cached_input) + event.total_output;
  return { used, limit: event.context_window, percent: used / event.context_window * 100 };
}
