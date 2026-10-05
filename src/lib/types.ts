export interface SessionMeta {
  file: string;
  files?: string[];
  id: string;
  cwd: string;
  model: string;
  timestamp: string;
  modified: string;
  cli_version: string;
  source: "codex" | "claude-code" | "collab";
  project?: string;
  /** A remote transcript replica with no local harness or terminal. */
  synced?: boolean;
  /** Persisted display name for custom sessions such as collaboration rooms. */
  customName?: string;
  /** Native manifest backing a custom session. */
  manifest?: string;
  /** Parent Codex thread for a spawned sub-agent rollout. */
  parentSessionId?: string;
  agentPath?: string;
  agentNickname?: string;
  agentDepth?: number;
  /** Latest lifecycle state inferred from Codex task events. */
  agentStatus?: "running" | "complete" | "interrupted";
}

export type TranscriptSessionMeta = SessionMeta & {
  source: "codex" | "claude-code";
};

export interface FileInfo {
  action: "add" | "update" | "delete";
  path: string;
}

export interface SessionStartEvent {
  kind: "session_start";
  ts: string;
  id: string;
  cwd: string;
  model: string;
  source?: string;
}

export interface UserMessageEvent {
  kind: "user_message";
  ts: string;
  text: string;
  images?: string[];
}

export interface AgentMessageEvent {
  kind: "agent_message";
  ts: string;
  text: string;
  phase?: string;
}

export interface ReasoningEvent {
  kind: "reasoning";
  ts: string;
  text: string;
}

export interface ContextCompactionEvent {
  kind: "context_compaction";
  ts: string;
  text: string;
}

export interface SubagentSpawnEvent {
  kind: "subagent_spawn";
  ts: string;
  sessionId: string;
  agentPath?: string;
  agentNickname?: string;
  agentDepth: number;
  agentStatus?: SessionMeta["agentStatus"];
}

export interface FileChangeEvent {
  kind: "file_change";
  ts: string;
  patch: string;
  files: FileInfo[];
  callId?: string;
  toolName?: string;
  /** How strongly the transcript proves that this tool changed the file. */
  attribution?: "tool_completed" | "tool_requested" | "legacy";
}

export interface ShellCommandEvent {
  kind: "shell_command";
  ts: string;
  cmd: string;
  workdir: string;
  callId?: string;
  toolName?: string;
  description?: string;
}

export interface ToolCallEvent {
  kind: "tool_call";
  ts: string;
  toolName: string;
  text: string;
  callId?: string;
}

export interface ToolOutputEvent {
  kind: "tool_output";
  ts: string;
  output: string;
  callId?: string;
}

export interface TokenUsageEvent {
  kind: "token_usage";
  ts: string;
  total_input: number;
  cached_input: number;
  total_output: number;
  reasoning_output: number;
  total_tokens: number;
  context_window: number;
  last_input: number;
  last_output: number;
}

/**
 * What the agent had available, as Claude records it. Claude mostly writes
 * deltas, so fields are applied in order: list fields named `*Added` /
 * `*Removed` adjust the running set, the others replace it.
 */
export interface CapabilitiesEvent {
  kind: "capabilities";
  ts: string;
  /** Tools loaded into every request (replaces the previous list). */
  tools?: string[];
  /** Tools available on demand, including every MCP tool. */
  toolsAdded?: string[];
  toolsRemoved?: string[];
  /** MCP servers with an explicit status (replaces the previous list). */
  mcpServers?: { name: string; status: string }[];
  failedMcpServers?: string[];
  pendingMcpServers?: string[];
  needsAuthMcpServers?: string[];
  skills?: string[];
  skillsAdded?: string[];
  agentsAdded?: string[];
  agentsRemoved?: string[];
  plugins?: string[];
}

export type AppEvent =
  | SessionStartEvent
  | CapabilitiesEvent
  | UserMessageEvent
  | AgentMessageEvent
  | ReasoningEvent
  | ContextCompactionEvent
  | SubagentSpawnEvent
  | FileChangeEvent
  | ShellCommandEvent
  | ToolCallEvent
  | ToolOutputEvent
  | TokenUsageEvent;

export interface TokenAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Bash commands by tool_use id, to classify the files a command changed. */
  bashCommands?: Map<string, string>;
}
