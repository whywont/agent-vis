# Native Provider Runtime

Agent Vis uses T3 Code's provider architecture as a reference without linking or
shipping the T3 server. The implementation stays inside the existing Tauri and
React application.

## Contract Layers

Each harness is split into three independent responsibilities:

1. **Driver inventory** discovers installation, version, authentication, models,
   slash commands, and skills.
2. **Runtime adapter** implements session start/resume, turns, interruption,
   approvals, structured user input, shutdown, thread reads, rollback, and model
   changes.
3. **Instance registry** routes by configured instance ID and owns the processes
   and connections created by each instance.

This prevents UI code from branching on individual CLIs and permits multiple
configured accounts of the same harness later.

## Built-in Coverage

| Driver | Transport | Inventory source | Native runtime |
| --- | --- | --- | --- |
| Codex | app-server | app-server initialization, account, model, and skill RPCs | Available |
| Claude Code | stream JSON | CLI version/auth probes and session initialization | Available |
| Cursor Agent | ACP | `cursor-agent` probe followed by ACP initialization | Planned |
| Grok | ACP | `grok --version` followed by ACP initialization | Planned |
| OpenCode | local HTTP server | CLI version and server provider inventory | Planned |

Every driver has the same complete `requiredOperations` target. `runtimeAvailable`
stays false until its native transport is usable, so catalog coverage cannot
accidentally advertise a selectable but unusable harness. Inventory flags describe
the discovery surface each finished driver must populate; they do not claim that
the current implementation already performs every probe.

## Startup Inventory

The native registry exists before any CLI process is started, so the renderer can
immediately show all built-in providers in a `checking` state. At application
startup it probes every executable concurrently with a three-second per-process
timeout and caches installation and version snapshots. Each completed probe emits
`agent-provider-inventory-updated`; one missing or hung harness therefore cannot
delay the other providers or application startup.

The probe commands are fixed by the native driver catalog rather than accepted
from renderer input. Codex, Claude Code, Grok, and OpenCode use `--version`;
Cursor Agent uses `about`, matching its supported installation/authentication
inspection command. Later inventory commits will enrich the same snapshots with
authentication, models, commands, and skills through each provider's native
protocol.

## Desktop Launch Environment

Packaged desktop applications frequently start without the environment a user's
terminal receives. Before starting provider inventory, Agent Vis reads a bounded
set of launch variables from the user's login shell and merges its `PATH` ahead
of the inherited desktop path without duplicates. macOS falls back to
`launchctl getenv PATH` if the login shell does not return one.

The resolved environment is kept inside the native process and applied directly
to child commands; it is never returned to the renderer. Provider probes and the
existing Codex and Claude launchers therefore resolve binaries and credentials
consistently. In addition to `PATH`, this preserves shell-provided SSH agent,
Homebrew, XDG, display, Wayland, and Linux session-bus variables needed by local
and remote-oriented harnesses.
