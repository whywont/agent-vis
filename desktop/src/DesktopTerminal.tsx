import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { resizeTerminal, startTerminal, stopTerminal, writeTerminal } from "./desktop-api";

interface TerminalOutput {
  terminalId: string;
  data: string;
}

export default function DesktopTerminal({
  sessionCwd,
  sessionId,
  sessionSource,
  terminalId,
  panelHeight,
  active,
  prefillResume,
  paneCount,
  stopOnUnmount = false,
}: {
  sessionCwd: string;
  sessionId: string;
  sessionSource: "codex" | "claude-code";
  terminalId: string;
  panelHeight: number;
  active: boolean;
  prefillResume: boolean;
  paneCount: number;
  /** Editor-owned terminals end when their dock closes. */
  stopOnUnmount?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [error, setError] = useState("");
  const terminalIdRef = useRef(terminalId);

  useEffect(() => {
    const terminalId = terminalIdRef.current;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    let fitAddon: import("@xterm/addon-fit").FitAddon | undefined;
    let lastSize = "";
    let started = false;
    let draftTimer: number | undefined;

    function fitToContainer() {
      if (!terminal || !fitAddon) return;
      fitAddon.fit();
      const size = `${terminal.cols}:${terminal.rows}`;
      if (started && size !== lastSize) {
        lastSize = size;
        void resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(() => {});
      }
    }

    async function open() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;

      terminal = new Terminal({
        theme: {
          background: "#181818",
          foreground: "#d4d4d4",
          cursor: "#aeafad",
          cursorAccent: "#181818",
          selectionBackground: "rgba(100, 100, 100, 0.42)",
          black: "#181818",
          brightBlack: "#777777",
          red: "#f48771",
          brightRed: "#f48771",
          green: "#89d185",
          brightGreen: "#89d185",
          yellow: "#dcdcaa",
          brightYellow: "#dcdcaa",
          blue: "#75beff",
          brightBlue: "#75beff",
          magenta: "#c586c0",
          brightMagenta: "#c586c0",
          cyan: "#4ec9b0",
          brightCyan: "#4ec9b0",
          white: "#d4d4d4",
          brightWhite: "#ffffff",
        },
        fontFamily: '"SF Mono", "Cascadia Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.45,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10_000,
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
      terminal.open(containerRef.current);
      fitToContainer();
      terminal.focus();
      terminalRef.current = terminal;

      unlisten = await listen<TerminalOutput>("terminal-output", (event) => {
        if (event.payload.terminalId !== terminalId) return;
        terminal?.write(event.payload.data);
      });
      if (disposed) return;
      terminal.onData((data) => {
        void writeTerminal(terminalId, data).catch(() => {
          terminal?.write("\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n");
        });
      });
      const terminalStarted = await startTerminal(terminalId, sessionCwd);
      started = true;
      lastSize = "";
      fitToContainer();
      if (prefillResume && terminalStarted) {
        // zsh emits its first prompt after startup. Send the draft to its line
        // editor without a newline, so it remains editable and Enter executes it.
        draftTimer = window.setTimeout(() => {
          if (!disposed) {
            void writeTerminal(
              terminalId,
              sessionSource === "codex"
                ? `codex resume ${sessionId}`
                : `claude --resume ${sessionId}`,
            );
          }
        }, 300);
      }
    }

    void open().catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "Unable to start terminal.");
    });
    return () => {
      disposed = true;
      if (draftTimer !== undefined) window.clearTimeout(draftTimer);
      unlisten?.();
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (stopOnUnmount) void stopTerminal(terminalId).catch(() => {});
      // The session owner stops this terminal on an explicit close. This
      // cleanup also runs during Vite HMR, where killing Codex would be wrong.
    };
  }, [prefillResume, sessionCwd, sessionId, sessionSource, stopOnUnmount, terminalId]);

  useLayoutEffect(() => {
    if (!active) return;
    const timers: number[] = [];
    function refit(): boolean {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const container = containerRef.current;
      if (!terminal || !fitAddon || !container) return false;
      // xterm caches its canvas size. Never fit against the hidden/zero-width
      // layout it had while another session terminal was visible.
      if (container.getBoundingClientRect().width < 100) return false;
      fitAddon.fit();
      terminal.refresh(0, terminal.rows - 1);
      terminal.focus();
      void resizeTerminal(terminalIdRef.current, terminal.cols, terminal.rows).catch(() => {});
      return true;
    }
    // Session-owned canvases can reactivate after the dock's portal and width
    // have both settled. A few bounded retries avoid a resize-observer loop.
    const firstFrame = requestAnimationFrame(() => {
      if (refit()) return;
      [40, 140, 320].forEach((delay) => {
        timers.push(window.setTimeout(() => { refit(); }, delay));
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [active, paneCount, panelHeight]);

  function scrollTerminal(event: React.WheelEvent<HTMLDivElement>) {
    const terminal = terminalRef.current;
    if (!terminal || event.deltaY === 0) return;
    event.preventDefault();
    terminal.scrollLines(Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 22)));
  }

  return (
    <div
      className={`desktop-terminal-surface${active ? " active" : ""}`}
      aria-label={`Terminal for ${sessionId}`}
      onWheel={scrollTerminal}
    >
      {error ? (
        <div className="desktop-terminal-error">{error}</div>
      ) : (
        <div className="desktop-terminal-container" ref={containerRef} />
      )}
    </div>
  );
}
