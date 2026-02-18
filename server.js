// Custom Next.js server — adds WebSocket terminal support via node-pty
const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const os = require("os");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3333", 10);

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });

  // WebSocket server — only handles /api/terminal upgrades
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);
    if (pathname === "/api/terminal") {
      // Only allow connections from localhost — the terminal spawns a real
      // shell so we must never expose it to the network.
      const ip = req.socket.remoteAddress;
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      // Let Next.js handle its own upgrade requests (HMR etc.)
      socket.destroy();
    }
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const rawCwd = url.searchParams.get("cwd") || os.homedir();
    const sessionId = url.searchParams.get("sessionId") || "";
    // Expand ~ and ensure the directory exists; fall back to home
    const cwd = rawCwd.startsWith("~")
      ? rawCwd.replace(/^~/, os.homedir())
      : rawCwd;

    const shell = process.env.SHELL || "/bin/bash";

    // Strip CLAUDECODE so the spawned shell can run `claude` without the
    // "nested session" error. The child process is fully independent.
    const env = { ...process.env };
    delete env.CLAUDECODE;

    let ptyProc;
    try {
      ptyProc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (err) {
      ws.send(`\r\n\x1b[31mFailed to spawn shell: ${err.message}\x1b[0m\r\n`);
      ws.close();
      return;
    }

    // Resume the specific Claude Code session being viewed.
    // `--resume <id>` continues that exact conversation thread; the output
    // lands in the same JSONL file so agent-vis picks it up via polling.
    // If no session ID was provided fall back to --continue (most recent).
    // Small delay lets the shell finish rc-file init first.
    const resumeCmd = sessionId
      ? `claude --resume ${sessionId}\n`
      : `claude --continue\n`;
    const autoLaunchTimer = setTimeout(() => {
      try { ptyProc.write(resumeCmd); } catch {}
    }, 350);

    // PTY → browser
    ptyProc.onData((data) => {
      try {
        ws.send(data);
      } catch {}
    });

    // PTY exit → close WS
    ptyProc.onExit(() => {
      try {
        ws.send("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
        ws.close();
      } catch {}
    });

    // Browser → PTY
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input") {
          ptyProc.write(msg.data);
        } else if (msg.type === "resize") {
          ptyProc.resize(
            Math.max(1, msg.cols || 80),
            Math.max(1, msg.rows || 24)
          );
        }
      } catch {
        // Treat as raw input
        ptyProc.write(raw.toString());
      }
    });

    ws.on("close", () => {
      clearTimeout(autoLaunchTimer);
      try {
        ptyProc.kill();
      } catch {}
    });
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(
      `   \x1b[32m▲ Next.js ${require("next/package.json").version}\x1b[0m`
    );
    console.log(`   - Local:   http://localhost:${port}`);
    console.log(`   - Terminal: ws://localhost:${port}/api/terminal`);
  });
});
