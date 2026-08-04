// Custom Next.js server — adds WebSocket terminal support via node-pty
const { createServer } = require("http");
const crypto = require("crypto");
const fs = require("fs");
const next = require("next");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const os = require("os");
const path = require("path");

function loadEnvFile(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3333", 10);
const rawHosts =
  process.env.HOSTS ||
  process.env.AGENT_VIS_HOSTS ||
  process.env.HOST ||
  process.env.AGENT_VIS_HOST ||
  "127.0.0.1";
const hosts = rawHosts
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const authToken = process.env.AGENT_VIS_AUTH_TOKEN || "";
const allowRemoteTerminal = process.env.AGENT_VIS_ALLOW_REMOTE_TERMINAL === "1";
const allowRemoteAgentChat = process.env.AGENT_VIS_ALLOW_REMOTE_AGENT_CHAT === "1";
const COOKIE_NAME = "agent_vis_auth";

// A cross-origin page in the victim's browser can open a WebSocket to
// ws://127.0.0.1:PORT/api/terminal — WebSocket connections are not gated by the
// same-origin policy, and the source IP is loopback, so without this check any
// website could spawn a shell. Browsers always send an Origin header on a WS
// handshake, and it cannot be forged by page JavaScript, so we require it to
// match the host the app is served on. Requests with no Origin are non-browser
// clients (native ws tooling), which are not the drive-by threat.
function isSameOriginUpgrade(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isLoopbackAddress(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1"
  );
}

function isLoopbackHost(value) {
  return (
    value === "127.0.0.1" ||
    value === "localhost" ||
    value === "::1"
  );
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(a || "");
  const bBuf = Buffer.from(b || "");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isAuthenticated(req, url) {
  if (!authToken) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const queryToken = url.searchParams.get("token") || "";
  const cookieToken = getCookies(req)[COOKIE_NAME] || "";
  return (
    safeEqual(bearer, authToken) ||
    safeEqual(queryToken, authToken) ||
    safeEqual(cookieToken, authToken)
  );
}

function sendAuthPage(req, res, status = 401) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent-vis login</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1a1a1a; color: #d4d4d4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 12px; }
    h1 { color: #c9a55a; font-size: 18px; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 4px; }
    input, button { font: inherit; border-radius: 6px; border: 1px solid #3a3a3a; padding: 11px 12px; }
    input { background: #222; color: #d4d4d4; }
    button { background: #c9a55a; color: #1a1a1a; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <form method="GET" action="/auth">
    <h1>agent-vis</h1>
    <input name="token" type="password" autocomplete="current-password" placeholder="Access token" autofocus />
    <button type="submit">Open</button>
  </form>
</body>
</html>`);
}

function setAuthCookieAndRedirect(res) {
  res.writeHead(302, {
    "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    "Location": "/",
    "Cache-Control": "no-store",
  });
  res.end();
}

if (hosts.some((host) => !isLoopbackHost(host)) && !authToken) {
  console.error(
    "Refusing to bind agent-vis to a non-local host without AGENT_VIS_AUTH_TOKEN."
  );
  console.error(
    "Set AGENT_VIS_AUTH_TOKEN before using HOST=0.0.0.0 or a Tailscale IP."
  );
  process.exit(1);
}

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/auth") {
      if (!authToken) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      if (isAuthenticated(req, url)) {
        setAuthCookieAndRedirect(res);
        return;
      }
      sendAuthPage(req, res, 401);
      return;
    }

    if (authToken && !isAuthenticated(req, url)) {
      sendAuthPage(req, res, 401);
      return;
    }

    handle(req, res);
  });

  // WebSocket server — only handles /api/terminal upgrades
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const { pathname } = url;
    if (pathname === "/api/terminal") {
      if (!isSameOriginUpgrade(req)) {
        socket.destroy();
        return;
      }
      const ip = req.socket.remoteAddress;
      const localClient = isLoopbackAddress(ip);
      const chatMode = url.searchParams.get("mode") === "chat";
      const remoteAllowed = chatMode ? allowRemoteAgentChat : allowRemoteTerminal;
      if (!localClient && (!remoteAllowed || !authToken || !isAuthenticated(req, url))) {
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
    // sessionId is interpolated into a shell command (`claude --resume <id>`),
    // so restrict it to the characters a real session id uses. Anything else is
    // dropped, falling back to --continue / resume --last.
    const rawSessionId = url.searchParams.get("sessionId") || "";
    const sessionId = /^[A-Za-z0-9._-]+$/.test(rawSessionId) ? rawSessionId : "";
    const sessionType = url.searchParams.get("type") === "codex" ? "codex" : "claude";
    const chatMode = url.searchParams.get("mode") === "chat";
    const sendChatStatus = (status) => {
      if (chatMode && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "agent-chat-status", status }));
      }
    };
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
    function attachPty(command, args) {
      let recentOutput = "";
      try {
        ptyProc = pty.spawn(command, args, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd,
          env,
        });
      } catch (err) {
        ws.send(`\r\n\x1b[31mFailed to start agent: ${err.message}\x1b[0m\r\n`);
        ws.close();
        return false;
      }
      ptyProc.onData((data) => {
        recentOutput = `${recentOutput}${data}`.slice(-4_000);
        try { ws.send(data); } catch {}
      });
      ptyProc.onExit(({ exitCode }) => {
        if (chatMode) {
          // `codex exec resume` ends after one durable turn. Keep the phone
          // socket open so the next message can start the next turn directly.
          console.log(`[agent chat] turn finished (exit ${exitCode})`);
          ptyProc = undefined;
          if (exitCode === 0) {
            sendChatStatus("ready");
          } else if (ws.readyState === ws.OPEN) {
            const detail = recentOutput
              .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(-700);
            ws.send(JSON.stringify({ type: "agent-chat-error", detail: detail || `Codex exited with code ${exitCode}.` }));
          }
          return;
        }
        try {
          ws.send("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
          ws.close();
        } catch {}
      });
      return true;
    }

    if (chatMode) {
      // Codex accepts an initial prompt as an argument to `resume`. Starting
      // only after Send makes the first message atomic with the resume command.
      console.log(`[agent chat] ready for ${sessionType} session`);
      sendChatStatus("ready");
    } else if (attachPty(shell, [])) {
      setTimeout(() => {
        try {
          ptyProc.write(` ${sessionType === "codex"
            ? (sessionId ? `codex resume ${sessionId}` : "codex resume --last")
            : (sessionId ? `claude --resume ${sessionId}` : "claude --continue")}\n`);
        } catch {}
      }, 350);
    }

    // Browser → PTY
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input") {
          if (chatMode) {
            const input = typeof msg.data === "string" ? msg.data.trim() : "";
            if (!input || input.length > 16_384) return;
            if (!ptyProc) {
              const args = sessionType === "codex"
                // `exec resume` records the prompt directly in the durable
                // Codex conversation; unlike the TUI, it has no input race.
                ? ["exec", "resume", ...(sessionId ? [sessionId] : ["--last"]), input]
                : sessionId ? ["--resume", sessionId, input] : ["--continue", input];
              if (!attachPty(sessionType === "codex" ? "codex" : "claude", args)) return;
              console.log("[agent chat] started resumed session with phone message");
            } else {
              ptyProc.write(`${input}\r`);
              console.log("[agent chat] message accepted by PTY");
            }
            sendChatStatus("working");
          } else {
            ptyProc?.write(msg.data);
          }
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
      try {
        ptyProc?.kill();
      } catch {}
    });
  });

  hosts.forEach((host, index) => {
    const server = index === 0 ? httpServer : createServer((req, res) => {
      httpServer.emit("request", req, res);
    });
    if (index !== 0) {
      server.on("upgrade", (req, socket, head) => {
        httpServer.emit("upgrade", req, socket, head);
      });
    }
    server.listen(port, host, () => {
      if (index === 0) {
        console.log(
          `   \x1b[32m▲ Next.js ${require("next/package.json").version}\x1b[0m`
        );
        console.log(`   - Local:   http://localhost:${port}`);
        if (authToken) console.log("   - Auth:    enabled");
        console.log(
          `   - Terminal: ${allowRemoteTerminal ? "remote enabled" : "local only"}`
        );
        console.log(
          `   - Agent chat: ${allowRemoteAgentChat ? "remote enabled" : "local only"}`
        );
      }
      console.log(`   - Bind:    http://${host}:${port}`);
    });
  });
});
