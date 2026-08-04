"use client";

import { useEffect, useRef, useState } from "react";

type ConnectionState = "connecting" | "ready" | "working" | "error" | "closed";

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
  const [message, setMessage] = useState("");
  const [state, setState] = useState<ConnectionState>("connecting");
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
        if (message.type === "agent-chat-status" && message.status) setState(message.status);
        if (message.type === "agent-chat-error") {
          setError(message.detail || "The agent process exited unexpectedly.");
          setState("error");
        }
      } catch {
        // Raw terminal output is intentionally not rendered in the mobile chat.
      }
    };
    socket.onclose = () => setState("closed");
    socket.onerror = () => setState("closed");

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [sessionCwd, sessionId, sessionType]);

  function send() {
    const text = message.trim();
    if (!text || socketRef.current?.readyState !== WebSocket.OPEN || state === "connecting") return;
    socketRef.current.send(JSON.stringify({ type: "input", data: `${text}\r` }));
    setMessage("");
    setError("");
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
            : state === "working"
              ? "Agent is working. You can leave this app; the reply will appear in the timeline."
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
          disabled={state === "connecting" || state === "working" || state === "closed"}
        />
        <button type="submit" disabled={!message.trim() || state === "connecting" || state === "working" || state === "closed"}>send</button>
      </form>
    </section>
  );
}
