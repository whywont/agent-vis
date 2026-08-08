import {
  compactCodexThread,
  connectClaudeThread,
  connectCodexThread,
  interruptCodexTurn,
  listCodexMcpServers,
  listCodexModels,
  listCodexSkills,
  readCodexThreadStatus,
  sendClaudeTurn,
  sendCodexTurn,
  setCodexThreadModel,
  startCodexReview,
} from "./desktop-api";

export type LiveProvider = "codex" | "claude-code";
export type ModelOption = readonly [id: string, description: string];
export type EffortOption = readonly [id: string, description: string];

export type HarnessContext = {
  sessionKey: string;
  threadId: string;
  cwd: string;
  activeTurnId: string | null;
  tokenUsage?: { total: number; input: number; output: number };
};

export type HarnessCommand = {
  id: string;
  description: string;
  native?: boolean;
};

export type ModelSelection =
  | { type: "send"; command: string }
  | { type: "complete"; output: string };

export interface HarnessAdapter {
  readonly id: LiveProvider;
  readonly label: string;
  readonly initialCommands: readonly HarnessCommand[];
  connect(context: HarnessContext): Promise<void>;
  sendTurn(context: HarnessContext, text: string, imageUrls: string[]): Promise<void>;
  models(context: HarnessContext): Promise<readonly ModelOption[]>;
  selectModel(context: HarnessContext, model: string): Promise<ModelSelection>;
  executeCommand?(command: string, context: HarnessContext): Promise<string | null>;
  commandDescription(command: string): string;
}

const CODEX_COMMANDS: readonly HarnessCommand[] = [
  ["compact", "Summarize history and free context"],
  ["mcp", "List configured MCP servers"],
  ["model", "Show or change the active model"],
  ["review", "Review the current working tree"],
  ["skills", "List available skills"],
  ["status", "Show session status"],
  ["stop", "Stop the active turn"],
].map(([id, description]) => ({ id, description, native: true }));

// Claude replaces this with the exact catalog from its init frame. Keeping a
// baseline avoids an empty picker if the startup frame arrived before mount.
const CLAUDE_COMMANDS: readonly HarnessCommand[] = [
  ["agents", "Manage Claude agents"], ["batch", "Run a batch workflow"],
  ["code-review", "Run a code review"], ["compact", "Summarize history and free context"],
  ["config", "Inspect configuration"], ["context", "Inspect context usage"],
  ["doctor", "Diagnose the Claude installation"], ["effort", "Show or change reasoning effort"],
  ["fast", "Toggle fast mode"], ["goal", "Show or change the current goal"],
  ["init", "Create project instructions"], ["mcp", "Inspect MCP connections"],
  ["model", "Show or change the active model"], ["recap", "Recap the conversation"],
  ["review", "Review the current working tree"], ["security-review", "Run a security review"],
  ["simplify", "Simplify the current work"], ["usage", "Show account usage"],
].map(([id, description]) => ({ id, description }));

export const CLAUDE_MODEL_OPTIONS: readonly ModelOption[] = [
  ["default", "Claude's configured default"],
  ["opus", "Highest capability"],
  ["sonnet", "Balanced speed and capability"],
  ["haiku", "Fastest, lightest model"],
  ["fable", "Claude Fable"],
  ["best", "Best available model"],
  ["opusplan", "Opus for planning"],
  ["opus[1m]", "Opus with 1M context"],
  ["sonnet[1m]", "Sonnet with 1M context"],
  ["fable[1m]", "Fable with 1M context"],
];

export const CLAUDE_EFFORT_OPTIONS: readonly EffortOption[] = [
  ["default", "Claude's configured default"],
  ["low", "Faster responses with lighter reasoning"],
  ["medium", "Balanced reasoning"],
  ["high", "More thorough reasoning"],
  ["xhigh", "Extended reasoning"],
  ["max", "Maximum available reasoning"],
];

const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  initialCommands: CODEX_COMMANDS,
  connect: ({ sessionKey, threadId, cwd }) => connectCodexThread(sessionKey, threadId, cwd),
  sendTurn: ({ sessionKey, threadId, activeTurnId }, text, imageUrls) =>
    sendCodexTurn(sessionKey, threadId, activeTurnId === "pending-turn" ? null : activeTurnId, text, imageUrls),
  async models({ sessionKey, threadId, cwd }) {
    const models = await listCodexModels(sessionKey, threadId, cwd);
    return models.map((model): ModelOption => [
      model.id || model.model || "",
      model.description || model.displayName || (model.isDefault ? "Default model" : "Codex model"),
    ]).filter(([id]) => Boolean(id));
  },
  async selectModel({ sessionKey, threadId, cwd }, model) {
    await setCodexThreadModel(sessionKey, threadId, cwd, model);
    return { type: "complete", output: `Codex model set to ${model}.` };
  },
  executeCommand: executeCodexCommand,
  commandDescription: commandDescription(CODEX_COMMANDS),
};

const claudeAdapter: HarnessAdapter = {
  id: "claude-code",
  label: "Claude",
  initialCommands: CLAUDE_COMMANDS,
  connect: ({ sessionKey, threadId, cwd }) => connectClaudeThread(sessionKey, threadId, cwd),
  sendTurn: ({ sessionKey }, text, imageUrls) => sendClaudeTurn(sessionKey, text, imageUrls),
  models: async () => CLAUDE_MODEL_OPTIONS,
  selectModel: async (_context, model) => ({ type: "send", command: `/model ${model}` }),
  commandDescription: commandDescription(CLAUDE_COMMANDS),
};

export function getHarnessAdapter(provider: LiveProvider): HarnessAdapter {
  return provider === "codex" ? codexAdapter : claudeAdapter;
}

function commandDescription(commands: readonly HarnessCommand[]) {
  const descriptions = new Map(commands.map((command) => [command.id, command.description]));
  return (command: string) => descriptions.get(command) || "Run this session command";
}

async function executeCodexCommand(command: string, context: HarnessContext): Promise<string | null> {
  const request = { sessionKey: context.sessionKey, threadId: context.threadId, cwd: context.cwd };
  if (command === "/compact") {
    await compactCodexThread(context.sessionKey, context.threadId, context.cwd);
    return "Compacting conversation context...";
  }
  if (command === "/review") {
    await startCodexReview(request);
    return "Reviewing uncommitted changes...";
  }
  if (command === "/stop") {
    if (!context.activeTurnId) return "No active Codex turn to stop.";
    await interruptCodexTurn(context.sessionKey, context.threadId, context.activeTurnId);
    return "Stopping the active Codex turn...";
  }
  if (command === "/status") return formatCodexStatus(await readCodexThreadStatus(request), context);
  if (command === "/skills") return formatStructuredList(await listCodexSkills(request), "skills");
  if (command === "/mcp") return formatStructuredList(await listCodexMcpServers(request), "MCP servers");
  return null;
}

function formatCodexStatus(result: Record<string, unknown>, context: HarnessContext): string {
  const thread = objectValue(result.thread);
  const config = objectValue(result.config);
  const rollout = objectValue(result.rollout);
  const session = objectValue(rollout.session);
  const turnContext = objectValue(rollout.turnContext);
  const tokenInfo = objectValue(rollout.tokenInfo);
  const totalUsage = objectValue(tokenInfo.total_token_usage);
  const lastUsage = objectValue(tokenInfo.last_token_usage);
  const contextWindow = numberValue(tokenInfo.model_context_window);
  const sources = arrayStrings(result.instructionSources);
  const status = objectValue(thread.status).type;
  const model = stringValue(turnContext.model, thread.model, thread.modelName, config.model, config.model_provider);
  const effort = stringValue(turnContext.effort);
  const summary = stringValue(turnContext.summary);
  const provider = stringValue(session.model_provider, thread.modelProvider);
  const providerConfig = objectValue(objectValue(config.model_providers)[provider || ""]);
  const providerUrl = stringValue(providerConfig.base_url, providerConfig.baseUrl);
  const approval = stringValue(turnContext.approval_policy, thread.approvalPolicy, config.approval_policy, config.approvalPolicy);
  const sandboxPolicy = objectValue(turnContext.sandbox_policy);
  const sandbox = stringValue(sandboxPolicy.type, thread.sandboxPolicy, config.sandbox_mode, config.sandboxMode);
  const writableRoots = arrayStrings(turnContext.workspace_roots);
  const collaboration = stringValue(objectValue(turnContext.collaboration_mode).mode);
  const total = numberValue(totalUsage.total_tokens);
  const usedTokens = total !== undefined
    ? Math.max(0, total - (numberValue(totalUsage.cached_input_tokens) || 0))
    : context.tokenUsage?.total;
  const inputTokens = numberValue(totalUsage.input_tokens) ?? context.tokenUsage?.input;
  const outputTokens = numberValue(totalUsage.output_tokens) ?? context.tokenUsage?.output;
  const currentPromptTokens = numberValue(lastUsage.input_tokens);
  const contextUsed = currentPromptTokens && contextWindow ? Math.min(currentPromptTokens, contextWindow) : undefined;
  const contextLeft = contextUsed !== undefined && contextWindow ? Math.max(0, contextWindow - contextUsed) : undefined;
  return [
    `Status: ${typeof status === "string" ? status : "idle"}`,
    model && `Model: ${model}${effort ? ` (reasoning ${effort}${summary ? `, summaries ${summary}` : ""})` : ""}`,
    provider && `Model provider: ${provider}${providerUrl ? ` - ${providerUrl}` : ""}`,
    `Directory: ${stringValue(turnContext.cwd, context.cwd) || context.cwd}`,
    approval && `Permissions: ${formatPermissions(sandbox, approval)}`,
    writableRoots.length && `Writable roots: ${writableRoots.join(", ")}`,
    `Agents.md: ${sources.length ? sources.join(", ") : "<none>"}`,
    collaboration && `Collaboration mode: ${capitalize(collaboration)}`,
    `Session: ${context.threadId}`,
    usedTokens !== undefined && inputTokens !== undefined && outputTokens !== undefined
      && `Token usage: ${formatNumber(usedTokens)} total (${formatNumber(inputTokens)} input + ${formatNumber(outputTokens)} output)`,
    contextWindow && contextUsed !== undefined && contextLeft !== undefined
      && `Context window: ${Math.round((contextLeft / contextWindow) * 100)}% left (${formatNumber(contextUsed)} used / ${formatNumber(contextWindow)})`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatStructuredList(result: Record<string, unknown>, label: string): string {
  const data = Array.isArray(result.data) ? result.data : [];
  const entries = flattenStructuredEntries(data).slice(0, 30);
  if (!entries.length) return `No ${label} configured.`;
  return `${label[0].toUpperCase()}${label.slice(1)}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
}

function flattenStructuredEntries(entries: unknown[]): string[] {
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const value = objectValue(entry);
    // Codex's skills/list returns one result per cwd, each with a skills list.
    if (Array.isArray(value.skills)) return flattenStructuredEntries(value.skills);
    const title = stringValue(value.displayName, value.name, value.id, value.serverName);
    if (!title) return [];
    const description = stringValue(value.shortDescription, value.description, value.error);
    const state = typeof value.enabled === "boolean" ? (value.enabled ? "enabled" : "disabled")
      : stringValue(value.status, value.authStatus);
    return [`${title}${description ? ` - ${description}` : ""}${state ? ` (${state})` : ""}`];
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string") || null;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatNumber(value: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatPermissions(sandbox: string | null, approval: string): string {
  const sandboxLabel = sandbox === "workspace-write" ? "Workspace" : sandbox || "Custom";
  const approvalLabel = approval === "on-request" ? "Ask for approval" : approval;
  return `${sandboxLabel} (${approvalLabel})`;
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
