"use client";

import { useEffect, useRef, useState } from "react";

type ConnectionState = "connecting" | "ready" | "sending" | "working" | "error" | "closed";

export default function MobileAgentChat({
  sessionCwd,
  sessionId,
  sessionType,
}: {
  sessionCwd: string;
  sessionId: string;
  sessionType: "claude" | "codex";
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const safeToLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<ConnectionState>("connecting");
  const [safeToLeave, setSafeToLeave] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({
      cwd: sessionCwd,
      sessionId,
      type: sessionType,
      mode: "chat",
    });
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/terminal?${params}`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as { type?: string; status?: ConnectionState; detail?: string };
        if (message.type === "agent-chat-status" && message.status) {
          if (safeToLeaveTimerRef.current) clearTimeout(safeToLeaveTimerRef.current);
          setState(message.status);
          if (message.status === "working") {
            safeToLeaveTimerRef.current = setTimeout(() => setSafeToLeave(true), 20_000);
          } else {
            setSafeToLeave(false);
          }
        }
        if (message.type === "agent-chat-error") {
          if (safeToLeaveTimerRef.current) clearTimeout(safeToLeaveTimerRef.current);
          setSafeToLeave(false);
          setError(message.detail || "The agent process exited unexpectedly.");
          setState("error");
        }
      } catch {
        // Raw terminal output is intentionally not rendered in the mobile chat.
      }
    };
    socket.onclose = () => {
      if (safeToLeaveTimerRef.current) clearTimeout(safeToLeaveTimerRef.current);
      setSafeToLeave(false);
      setState("closed");
    };
    socket.onerror = () => {
      if (safeToLeaveTimerRef.current) clearTimeout(safeToLeaveTimerRef.current);
      setSafeToLeave(false);
      setState("closed");
    };

    return () => {
      if (safeToLeaveTimerRef.current) clearTimeout(safeToLeaveTimerRef.current);
      socket.close();
      socketRef.current = null;
    };
  }, [sessionCwd, sessionId, sessionType]);

  function send() {
    const text = message.trim();
    if (!text || socketRef.current?.readyState !== WebSocket.OPEN || state === "connecting") return;
    if (safeToLeaveTimerRef.current) clearTimeout(safeToLeaveTimerRef.current);
    socketRef.current.send(JSON.stringify({ type: "input", data: `${text}\r` }));
    setMessage("");
    setError("");
    setSafeToLeave(false);
    // This is deliberately distinct from "working": wait for the Mac to
    // acknowledge that it received and started the resumed turn before
    // telling someone it is safe to leave Safari.
    setState("sending");
  }

  return (
    <section className="mobile-agent-chat" aria-label="Agent chat">
      <div className="mobile-agent-chat-header">
        <span><b>{sessionType === "codex" ? "Codex" : "Claude"}</b> continue session</span>
        <span className={`mobile-agent-chat-state ${state}`}>{state === "ready" ? "ready" : state}</span>
      </div>
      {state !== "ready" && (
        <div className="mobile-agent-chat-status" aria-live="polite">
          {state === "connecting"
            ? "Connecting to your Mac..."
            : state === "sending"
              ? "Sending to your Mac. Keep this open until it starts..."
            : state === "working"
              ? safeToLeave
                ? "Agent is working. You can leave this app; the reply will appear in the timeline."
                : "Agent is starting. Keep this open for about 20 seconds..."
              : state === "error"
                ? error || "The agent could not complete that message."
                : "Connection closed. Reopen this session to reconnect."}
        </div>
      )}
      <form className="mobile-agent-chat-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message agent..."
          rows={2}
          disabled={state === "connecting" || state === "sending" || state === "working" || state === "closed"}
        />
        <button type="submit" disabled={!message.trim() || state === "connecting" || state === "sending" || state === "working" || state === "closed"}>send</button>
      </form>
    </section>
  );
}
