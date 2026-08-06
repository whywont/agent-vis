import { useEffect, useRef } from "react";
import { formatTime } from "@/utils/format";

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

export default function DesktopLiveStream({ entries }: { entries: LiveStreamEntry[] }) {
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [entries]);

  return (
    <div
      className="desktop-live-stream"
      aria-label="Live agent stream"
      ref={streamRef}
    >
      {entries.length ? entries.map((entry) => (
        <div className={`desktop-live-stream-line kind-${entry.kind}`} key={entry.id}>
          <b>
            <span>{labels[entry.kind]}</span>
            <time>{formatTime(entry.ts)}</time>
          </b>
          <pre>{entry.text}</pre>
        </div>
      )) : (
        <div className="desktop-live-stream-empty">Live bridge output appears here.</div>
      )}
    </div>
  );
}
