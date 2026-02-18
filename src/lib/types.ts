export interface SessionMeta {
  file: string;
  files?: string[];
  id: string;
  cwd: string;
  model: string;
  timestamp: string;
  modified: string;
  cli_version: string;
  source: "codex" | "claude-code";
  project?: string;
}

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

export interface FileChangeEvent {
  kind: "file_change";
  ts: string;
  patch: string;
  files: FileInfo[];
  callId?: string;
  toolName?: string;
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

export type AppEvent =
  | SessionStartEvent
  | UserMessageEvent
  | AgentMessageEvent
  | ReasoningEvent
  | FileChangeEvent
  | ShellCommandEvent
  | ToolOutputEvent
  | TokenUsageEvent;

export interface TokenAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}
