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
