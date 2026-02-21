<p align="center">
  <img src=".github/assets/logo.png" alt="agent-vis" width="220" />
</p>

<h1 align="center">agent-vis</h1>

<p align="center">A local viewer for Claude Code and Codex sessions. Watch agent activity in real time — patches, shell commands, reasoning, token usage — and interact with running sessions from your browser.</p>

<br />

<video src=".github/assets/agent-vis-demo.mp4" autoplay loop muted playsinline></video>

## Features

- **Session timeline** — all events in reverse-chronological order: file patches, shell commands, user/agent messages, reasoning, token usage; click any entry to expand
- **File tree** — changed files grouped by directory with add/modify/delete indicators; click any file to jump to its diff
- **Files graph** — playing-card stacks of file changes laid out as a canvas, with bezier edges showing import relationships between files; minimap for navigation
- **Terminal** — embedded terminal that resumes the session's Claude Code conversation in its working directory
- **AI explain** — highlight any diff and ask Claude to explain what changed and why (requires Anthropic API key)

## Install

Requires Node.js 18+. **macOS and Linux only** — Windows is not supported.

```bash
git clone https://github.com/whywont/agent-vis
cd agent-vis
npm install
npm run dev
```

Open [http://localhost:3333](http://localhost:3333).

Sessions are read directly from `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/` (Codex). Nothing is copied or stored.

## Environment

Copy `.env.example` to `.env.local` and fill in your key:

```bash
cp .env.example .env.local
```

```env
# Required only for the AI explain feature
ANTHROPIC_API_KEY=your_key_here
```

Get a key at [console.anthropic.com](https://console.anthropic.com). The app works fully without it — only the explain feature is gated.

## Notes

- The server binds to `127.0.0.1` only and is not accessible from other machines
- On macOS, `node-pty`'s spawn-helper is fixed automatically by the `postinstall` script
