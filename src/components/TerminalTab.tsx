"use client";

import { useEffect, useRef, useState } from "react";

interface TerminalTabProps {
  sessionCwd: string;
  sessionId?: string;
  sessionType?: "claude" | "codex";
}

export default function TerminalTab({ sessionCwd, sessionId, sessionType = "claude" }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">(
    "connecting"
  );
  const [uploadingImage, setUploadingImage] = useState(false);
  const [composerText, setComposerText] = useState("");

  function writeToTerminal(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  }

  function sendComposerOrEnter() {
    const text = composerText.trim();
    if (text) {
      writeToTerminal(`${text}\r`);
      setComposerText("");
      return;
    }
    writeToTerminal("\r");
  }

  async function handleImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploadingImage(true);
    try {
      const form = new FormData();
      form.set("image", file);
      const res = await fetch("/api/upload-image", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { path: string };
      if (window.matchMedia("(max-width: 760px)").matches) {
        setComposerText((text) => (text ? `${text} ${data.path}` : data.path));
      } else {
        writeToTerminal(` ${data.path}`);
      }
    } catch {
      termRef.current?.write("\r\n\x1b[31m[image upload failed]\x1b[0m\r\n");
    } finally {
      setUploadingImage(false);
    }
  }

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        theme: {
          background: "#1a1a1a",
          foreground: "#d4d4d4",
          cursor: "#c9a55a",
          cursorAccent: "#1a1a1a",
          selectionBackground: "rgba(201,165,90,0.25)",
          black: "#222222",
          red: "#d46a6a",
          green: "#6abf69",
          yellow: "#c9a55a",
          blue: "#6a9fd4",
          magenta: "#b48ead",
          cyan: "#88c0d0",
          white: "#d4d4d4",
          brightBlack: "#555",
          brightRed: "#e07a7a",
          brightGreen: "#7fcf7e",
          brightYellow: "#d4b06a",
          brightBlue: "#7aaee0",
          brightMagenta: "#c49ec0",
          brightCyan: "#9ed0dc",
          brightWhite: "#e8e8e8",
        },
        fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.45,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 5000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current!);
      fitAddon.fit();
      termRef.current = term;

      // Connect WebSocket
      const params = new URLSearchParams({ cwd: sessionCwd, type: sessionType });
      if (sessionId) params.set("sessionId", sessionId);
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//${window.location.host}/api/terminal?${params}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        setStatus("connected");
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          term.write(event.data);
        } else {
          term.write(new Uint8Array(event.data as ArrayBuffer));
        }
      };

      ws.onerror = () => {
        term.write(
          "\r\n\x1b[31m[WebSocket error — is the custom server running?]\x1b[0m\r\n"
        );
      };

      ws.onclose = () => {
        setStatus("closed");
        if (!disposed) {
          term.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
        }
      };

      // Terminal input → WS
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Resize observer
      const ro = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
            );
          }
        } catch {}
      });
      if (containerRef.current) ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        term.dispose();
        ws.close();
      };
    }

    let cleanup: (() => void) | undefined;
    init().then((fn) => {
      cleanup = fn;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [sessionCwd, sessionId, sessionType]);

  return (
    <div className="terminal-tab">
      <div className="terminal-status-bar">
        <span className="terminal-cwd">{sessionCwd}</span>
        <span className="terminal-model">{sessionType}</span>
        <input
          ref={imageInputRef}
          className="terminal-image-input"
          type="file"
          accept="image/*"
          onChange={handleImageSelected}
        />
        <button
          className="terminal-image-btn"
          type="button"
          disabled={uploadingImage || status !== "connected"}
          onClick={() => imageInputRef.current?.click()}
          title="Upload image and insert its local path"
        >
          {uploadingImage ? "uploading" : "photo"}
        </button>
        <span
          className={`terminal-status-dot ${
            status === "connected"
              ? "dot-add"
              : status === "closed"
              ? "dot-delete"
              : "dot-update"
          }`}
        />
        <span className="terminal-status-text">{status}</span>
      </div>
      <div ref={containerRef} className="terminal-container" />
      <form
        className="terminal-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (status !== "connected") return;
          sendComposerOrEnter();
        }}
      >
        <textarea
          className="terminal-composer-input"
          value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          placeholder="Type message..."
          rows={2}
        />
        <button
          className="terminal-composer-send"
          type="submit"
          disabled={status !== "connected"}
        >
          send
        </button>
      </form>
    </div>
  );
}
