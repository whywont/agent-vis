# agent-vis

A local viewer for Claude Code and Codex sessions. Watch agent activity in real time — patches, shell commands, reasoning, token usage — and interact with running sessions from your browser.

## Features

- **Session timeline** — all events from a session in reverse-chronological order: file patches, shell commands, user/agent messages, reasoning, token usage
- **File tree** — changed files grouped by directory with add/modify/delete indicators; click any file to jump to its diff
- **Files graph** — playing-card stacks of file changes laid out as a canvas, with bezier edges showing import relationships between files; minimap for navigation
- **Terminal** — embedded terminal that resumes the session's Claude Code conversation in its working directory

## Install

Requires Node.js 18+.

```bash
git clone https://github.com/whywont/agent-vis
cd agent-vis
npm install
npm run dev
```

Open [http://localhost:3333](http://localhost:3333).

Sessions are read directly from `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/` (Codex). Nothing is copied or stored.

## Notes

- The server binds to `127.0.0.1` only and is not accessible from other machines
- On macOS, `node-pty`'s spawn-helper is fixed automatically by the `postinstall` script
