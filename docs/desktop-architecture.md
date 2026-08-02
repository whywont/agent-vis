# Desktop Architecture

The desktop migration keeps the existing React visual language while removing
the localhost HTTP and WebSocket control plane from the desktop build.

## Security Boundary

- The renderer is untrusted and has no direct filesystem, keychain, network,
  shell, or process capability.
- Rust commands expose task-specific operations with validated inputs.
- Session access is restricted to the fixed Claude Code and Codex history roots.
- No general terminal command is part of the initial desktop capability set.
- Remote access, encrypted sync, OAuth, and peer-to-peer transport are later
  phases and do not expand this first milestone.

## Migration Sequence

1. List local sessions through a read-only Rust command.
2. Port session parsing and timeline rendering behind typed desktop APIs.
3. Add compact-context export to a user-selected destination.
4. Add an explicit `start_chat_with_context` command using executable argument
   arrays rather than shell interpolation.
5. Add local encryption and OS-keychain-backed device keys.
6. Add transport-independent device pairing and encrypted context replication.

The existing Next application stays operational during the migration. Desktop
components should depend on a typed service interface so the web API adapter can
be removed once feature parity is reached.
