import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppEvent } from "@/lib/types";
import {
  compactCodexThread,
  connectClaudeThread,
  connectCodexThread,
  respondToCodexApproval,
  listCodexModels,
  listCodexMcpServers,
  listCodexSkills,
  readCodexThreadStatus,
  sendClaudeTurn,
  sendCodexTurn,
  setCodexThreadModel,
  startCodexReview,
  interruptCodexTurn,
} from "./desktop-api";

type ApprovalDecision = string | Record<string, unknown>;

type Approval = {
  id: unknown;
  kind: "command" | "file" | "permissions";
  reason: string;
  details: string;
  decisions: ApprovalDecision[];
  permissions?: unknown;
  command?: string;
};

interface AppServerEvent {
  sessionKey: string;
  message: {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
}

interface ClaudeStreamEvent {
  sessionKey: string;
  message: Record<string, unknown>;
}

type LiveProvider = "codex" | "claude-code";

type ConnectionState = "idle" | "connecting" | "ready" | "error";

type ImageAttachment = { id: string; url: string; name: string };
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CODEX_SLASH_COMMANDS = ["compact", "mcp", "model", "review", "skills", "status", "stop"];
// Claude replaces this with the exact catalog from its init frame. Keeping a
// baseline avoids an empty picker if that startup frame arrived before mount.
const CLAUDE_SLASH_COMMANDS = [
  "agents", "batch", "code-review", "compact", "config", "context", "doctor",
  "effort", "fast", "goal", "init", "mcp", "model", "recap", "review",
  "security-review", "simplify", "usage",
];
const CLAUDE_MODEL_OPTIONS = [
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
] as const;
type ModelOption = readonly [id: string, description: string];

export default function DesktopLiveConversation({
  provider,
  sessionKey,
  threadId,
  cwd,
  onApprovalChange,
  onContextCompaction,
  onTimelineEvent,
  tokenUsage,
}: {
  provider: LiveProvider;
  sessionKey: string;
  threadId: string;
  cwd: string;
  onApprovalChange?: (command: string | null) => void;
  onContextCompaction?: () => void;
  onTimelineEvent?: (event: AppEvent) => void;
  tokenUsage?: { total: number; input: number; output: number };
}) {
  const [state, setState] = useState<ConnectionState>("idle");
  const [draft, setDraft] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [slashCommands, setSlashCommands] = useState<string[]>(() =>
    provider === "claude-code" ? CLAUDE_SLASH_COMMANDS : CODEX_SLASH_COMMANDS,
  );
  const [slashSelection, setSlashSelection] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSelection, setModelSelection] = useState(0);
  const [codexModels, setCodexModels] = useState<ModelOption[]>([]);
  const modelOptions: readonly ModelOption[] = provider === "codex"
    ? codexModels
    : CLAUDE_MODEL_OPTIONS;
  const pendingSlashCommand = useRef<{ command: string; callId: string; output: string } | null>(null);
  const slashInput = draft.startsWith("/") ? draft.slice(1).trimStart() : null;
  const slashQuery = slashInput?.split(/\s/, 1)[0].toLowerCase() ?? null;
  const matchingCommands = slashQuery === null ? [] : slashCommands.filter((command) => command.includes(slashQuery));
  const exactSlashCommand = slashQuery !== null && slashCommands.includes(slashQuery);
  const slashHasArguments = Boolean(slashInput && /\s/.test(slashInput));
  const showSlashPicker = matchingCommands.length > 0 && !slashHasArguments;

  useEffect(() => {
    if (!draft) composerRef.current?.style.removeProperty("height");
  }, [activeTurnId, draft]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    if (provider === "claude-code") {
      void listen<ClaudeStreamEvent>("claude-stream-event", (event) => {
        if (event.payload.sessionKey !== sessionKey) return;
        const message = event.payload.message;
        if (message.type === "agent-vis/disconnected") {
          setState("error");
          setError("Claude disconnected");
          setActiveTurnId(null);
          return;
        }
        if (message.type === "system" && message.status === "requesting") {
          setActiveTurnId("claude-turn");
          return;
        }
        if (message.type === "system" && message.subtype === "init") {
          const commands = Array.isArray(message.slash_commands)
            ? message.slash_commands.filter((value): value is string => typeof value === "string")
            : [];
          if (commands.length) setSlashCommands(commands);
        }
        if (message.type === "system" && message.subtype === "local_command") {
          const output = localCommandOutput(message.content);
          const pending = pendingSlashCommand.current;
          if (output && pending) {
            pending.output = output;
            onTimelineEvent?.({
              kind: "tool_output",
              ts: new Date().toISOString(),
              callId: pending.callId,
              output,
            });
          }
        }
        if (isClaudeCompaction(message)) onContextCompaction?.();
        if (message.type === "assistant" && pendingSlashCommand.current) {
          const output = assistantText(message);
          if (output) {
            const pending = pendingSlashCommand.current;
            pending.output = output;
            onTimelineEvent?.({
              kind: "tool_output",
              ts: new Date().toISOString(),
              callId: pending.callId,
              output,
            });
          }
        }
        if (message.type === "result") {
          const pending = pendingSlashCommand.current;
          const result = typeof message.result === "string" ? message.result.trim() : "";
          if (pending && result && result !== pending.output) {
            onTimelineEvent?.({
              kind: "tool_output",
              ts: new Date().toISOString(),
              callId: pending.callId,
              output: result,
            });
          }
          pendingSlashCommand.current = null;
          setActiveTurnId(null);
          if (message.subtype !== "success") {
            setState("error");
            setError(typeof message.result === "string" ? message.result : "Claude could not complete this turn.");
          } else {
            setState("ready");
          }
        }
      }).then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }
    void listen<AppServerEvent>("codex-app-server-event", (event) => {
      if (event.payload.sessionKey !== sessionKey) return;
      const { message } = event.payload;
      const params = message.params || {};
      if (message.method === "agent-vis/disconnected") {
        setState("error");
        setError("Codex disconnected");
        return;
      }
      if (message.method === "turn/started") {
        const turn = params.turn as { id?: string } | undefined;
        setActiveTurnId(turn?.id || null);
      }
      if (message.method === "turn/completed") setActiveTurnId(null);
      if (message.method === "thread/status/changed") {
        const status = params.status as { type?: string } | undefined;
        if (status?.type === "idle") setActiveTurnId(null);
      }
      if (message.method === "item/started" && isCodexCompaction(params.item)) {
        onContextCompaction?.();
      }
      if (message.method === "serverRequest/resolved") {
        setApproval(null);
        onApprovalChange?.(null);
      }
      const requestKind = message.method === "item/commandExecution/requestApproval" ? "command"
        : message.method === "item/fileChange/requestApproval" ? "file"
          : message.method === "item/permissions/requestApproval" ? "permissions" : null;
      if (!requestKind || message.id === undefined) return;
      const command = typeof params.command === "string" ? params.command : undefined;
      const permissions = params.permissions;
      const details = command
        || (typeof params.grantRoot === "string" ? params.grantRoot : "")
        || (permissions ? JSON.stringify(permissions) : "");
      setApproval({
        id: message.id,
        kind: requestKind,
        reason: typeof params.reason === "string" ? params.reason : "Codex needs permission to continue.",
        details,
        command,
        permissions,
        decisions: Array.isArray(params.availableDecisions)
          ? params.availableDecisions.filter((value): value is ApprovalDecision =>
            typeof value === "string" || (typeof value === "object" && value !== null),
          )
          : requestKind === "permissions" ? ["accept", "decline"] : ["accept", "acceptForSession", "decline", "cancel"],
      });
      onApprovalChange?.(command || null);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onApprovalChange, onContextCompaction, onTimelineEvent, provider, sessionKey]);

  async function connect(): Promise<boolean> {
    if (state === "connecting") return false;
    setState("connecting");
    setError("");
    try {
      if (provider === "codex") await connectCodexThread(sessionKey, threadId, cwd);
      else await connectClaudeThread(sessionKey, threadId, cwd);
      if (provider === "codex") {
        const models = await listCodexModels(sessionKey, threadId, cwd);
        setCodexModels(models.map((model): ModelOption => [
          model.id || model.model || "",
          model.description || model.displayName || (model.isDefault ? "Default model" : "Codex model"),
        ]).filter(([id]) => Boolean(id)));
      }
      setState("ready");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
      return false;
    }
  }

  async function submit(textOverride?: string) {
    const text = (textOverride ?? draft).trim();
    if ((!text && !images.length) || sending) return;
    if (text === "/model") {
      if (provider === "codex" && !codexModels.length) {
        try {
          const models = await listCodexModels(sessionKey, threadId, cwd);
          setCodexModels(models.map((model): ModelOption => [
            model.id || model.model || "",
            model.description || model.displayName || "Codex model",
          ]).filter(([id]) => Boolean(id)));
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
          return;
        }
      }
      setModelPickerOpen(true);
      setModelSelection(0);
      return;
    }
    setSending(true);
    if (state !== "ready" && !(await connect())) {
      setSending(false);
      return;
    }
    try {
      const imageUrls = images.map((image) => image.url);
      const isSlashCommand = text.startsWith("/") && exactSlashCommand;
      const callId = isSlashCommand ? crypto.randomUUID() : undefined;
      if (isSlashCommand && callId) {
        onTimelineEvent?.({
          kind: "shell_command",
          ts: new Date().toISOString(),
          cmd: text,
          workdir: cwd,
          callId,
          toolName: "local_command",
          description: `${provider === "codex" ? "Codex" : "Claude"} session command`,
        });
        if (provider === "claude-code") {
          pendingSlashCommand.current = { command: text, callId, output: "" };
        }
      }
      if (provider === "codex" && isSlashCommand && imageUrls.length === 0) {
        const output = await executeCodexCommand(text, { sessionKey, threadId, cwd, activeTurnId, tokenUsage });
        if (output && callId) {
          onTimelineEvent?.({ kind: "tool_output", ts: new Date().toISOString(), callId, output });
        }
      } else if (provider === "codex" && text === "/compact" && imageUrls.length === 0) {
        await compactCodexThread(sessionKey, threadId, cwd);
      } else if (provider === "codex") await sendCodexTurn(sessionKey, threadId, text, imageUrls);
      else {
        await sendClaudeTurn(sessionKey, text, imageUrls);
        // Claude's stream reports completion as a result frame. Mark it busy
        // immediately so the shared status glyph cannot lag behind the send.
        setActiveTurnId("claude-turn");
      }
      setDraft("");
      setImages([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
    } finally {
      setSending(false);
    }
  }

  async function addImages(files: Iterable<File>) {
    const candidates = [...files]
      .filter((file) => file.type.startsWith("image/") && file.size <= MAX_IMAGE_BYTES)
      .slice(0, Math.max(0, MAX_IMAGE_ATTACHMENTS - images.length));
    const nextImages = await Promise.all(candidates.map(async (file) => ({
      id: crypto.randomUUID(),
      name: file.name || "Pasted image",
      url: await fileAsDataUrl(file),
    })));
    setImages((current) => [...current, ...nextImages].slice(0, MAX_IMAGE_ATTACHMENTS));
  }

  async function respondToApproval(decision: ApprovalDecision) {
    if (!approval) return;
    const result = approval.kind === "permissions"
      ? decision === "accept" ? { permissions: approval.permissions, scope: "turn" } : { permissions: {} }
      : { decision };
    try {
      await respondToCodexApproval(sessionKey, approval.id, result);
      setApproval(null);
      onApprovalChange?.(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function selectSlashCommand(command: string) {
    setDraft(`/${command} `);
    setSlashSelection(0);
    composerRef.current?.focus();
  }

  async function selectModel(model: string) {
    const command = `/model ${model}`;
    setDraft(command);
    setModelPickerOpen(false);
    if (provider === "claude-code") {
      void submit(command);
      return;
    }
    try {
      await setCodexThreadModel(sessionKey, threadId, cwd, model);
      onTimelineEvent?.({
        kind: "shell_command",
        ts: new Date().toISOString(),
        cmd: command,
        workdir: cwd,
        toolName: "local_command",
        description: "Codex session command",
      });
      onTimelineEvent?.({
        kind: "tool_output",
        ts: new Date().toISOString(),
        output: `Codex model set to ${model}.`,
      });
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className="desktop-codex-live-strip" aria-label={`Message ${provider === "codex" ? "Codex" : "Claude"}`}>
      <div className={`desktop-codex-live-bar${images.length ? " has-images" : ""}`}>
        <span
          className={`desktop-codex-live-dot ${approval ? "running" : activeTurnId ? "paused" : state}`}
          aria-label={approval ? "Codex needs approval" : activeTurnId ? `${provider === "codex" ? "Codex" : "Claude"} working` : `${provider === "codex" ? "Codex" : "Claude"} ready`}
          role="status"
        />
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSlashSelection(0);
            setModelPickerOpen(false);
          }}
          placeholder={activeTurnId ? `Steer ${provider === "codex" ? "Codex" : "Claude"}...` : `Message ${provider === "codex" ? "Codex" : "Claude"}...`}
          rows={1}
          onFocus={() => {
            if (state !== "ready" && state !== "connecting") void connect();
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (files.length) {
              event.preventDefault();
              void addImages(files);
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void addImages(event.dataTransfer.files);
          }}
          onInput={(event) => {
            const input = event.currentTarget;
            input.style.height = "auto";
            input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
          }}
          onKeyDown={(event) => {
            if (modelPickerOpen && event.key === "ArrowDown") {
              event.preventDefault();
              setModelSelection((current) => (current + 1) % modelOptions.length);
              return;
            }
            if (modelPickerOpen && event.key === "ArrowUp") {
              event.preventDefault();
              setModelSelection((current) => (current - 1 + modelOptions.length) % modelOptions.length);
              return;
            }
            if (modelPickerOpen && event.key === "Escape") {
              event.preventDefault();
              setModelPickerOpen(false);
              return;
            }
            if (modelPickerOpen && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void selectModel(modelOptions[modelSelection][0]);
              return;
            }
            if (showSlashPicker && event.key === "ArrowDown") {
              event.preventDefault();
              setSlashSelection((current) => (current + 1) % matchingCommands.length);
              return;
            }
            if (showSlashPicker && event.key === "ArrowUp") {
              event.preventDefault();
              setSlashSelection((current) => (current - 1 + matchingCommands.length) % matchingCommands.length);
              return;
            }
            if (showSlashPicker && event.key === "Escape") {
              event.preventDefault();
              setDraft("");
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (showSlashPicker && !exactSlashCommand) {
                selectSlashCommand(matchingCommands[Math.min(slashSelection, matchingCommands.length - 1)]);
                return;
              }
              void submit();
            }
          }}
        />
        {showSlashPicker && (
          <div className="desktop-slash-picker" role="listbox" aria-label="Available commands">
            {matchingCommands.slice(0, 8).map((command, index) => (
              <button
                key={command}
                type="button"
                className={index === slashSelection ? "selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectSlashCommand(command)}
                role="option"
                aria-selected={index === slashSelection}
              >
                <code>/{command}</code>
                <span>{slashCommandDescription(command)}</span>
              </button>
            ))}
          </div>
        )}
        {modelPickerOpen && modelOptions.length > 0 && (
          <div className="desktop-slash-picker desktop-model-picker" role="listbox" aria-label="Choose model">
            <header>Choose {provider === "codex" ? "Codex" : "Claude"} model</header>
            {modelOptions.map(([model, description], index) => (
              <button
                key={model}
                type="button"
                className={index === modelSelection ? "selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void selectModel(model)}
                role="option"
                aria-selected={index === modelSelection}
              >
                <code>{model}</code>
                <span>{description}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={() => void submit()} disabled={(!draft.trim() && !images.length) || sending}>
          {sending || state === "connecting" ? "Opening..." : activeTurnId ? "Steer" : "Send"}
        </button>
        {error && <span className="desktop-codex-live-error" title={error}>{error}</span>}
      </div>
      {images.length > 0 && (
        <div className="desktop-codex-image-attachments" aria-label="Attached images">
          {images.map((image) => (
            <figure key={image.id}>
              <img src={image.url} alt={image.name} />
              <button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Remove ${image.name}`}>x</button>
            </figure>
          ))}
        </div>
      )}
      {approval && (
        <aside className="desktop-codex-approval" aria-live="assertive">
          <span>Blocked - permission needed</span>
          <p>{approval.reason}</p>
          {approval.details && <code>{approval.details}</code>}
          <div>
            {approval.decisions.filter(isRenderableApprovalDecision).map((decision, index) => (
              <button key={approvalDecisionKey(decision)} type="button" onClick={() => void respondToApproval(decision)}>
                {approvalDecisionLabel(decision, index)}
              </button>
            ))}
          </div>
        </aside>
      )}
    </section>
  );
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

function isRenderableApprovalDecision(decision: ApprovalDecision): boolean {
  if (typeof decision === "string") return ["accept", "acceptForSession", "decline", "cancel"].includes(decision);
  return "acceptWithExecpolicyAmendment" in decision || "applyNetworkPolicyAmendment" in decision;
}

function approvalDecisionKey(decision: ApprovalDecision): string {
  return typeof decision === "string" ? decision : JSON.stringify(decision);
}

function approvalDecisionLabel(decision: ApprovalDecision, index: number): string {
  if (decision === "accept") return "1. Approve";
  if (decision === "acceptForSession" || (typeof decision === "object" && (
    "acceptWithExecpolicyAmendment" in decision || "applyNetworkPolicyAmendment" in decision
  ))) return "2. Approve, don't ask again";
  if (decision === "decline") return "Decline";
  if (decision === "cancel") return "Cancel turn";
  return `${index + 1}. Approve`;
}

function isCodexCompaction(item: unknown): boolean {
  return typeof item === "object" && item !== null
    && "type" in item && item.type === "contextCompaction";
}

function isClaudeCompaction(message: Record<string, unknown>): boolean {
  // Claude's stream schema has varied across versions. Its persisted
  // away_summary remains the fallback; recognize the live boundary when sent.
  return message.type === "system" && ["away_summary", "compact_boundary", "compaction"].includes(
    typeof message.subtype === "string" ? message.subtype : "",
  );
}

function slashCommandDescription(command: string): string {
  const descriptions: Record<string, string> = {
    compact: "Summarize history and free context",
    mcp: "List configured MCP servers",
    model: "Show or change the active model",
    effort: "Show or change reasoning effort",
    review: "Review the current working tree",
    "code-review": "Run a code review",
    simplify: "Simplify the current work",
    init: "Create project instructions",
    context: "Inspect context usage",
    status: "Show session status",
    skills: "List available skills",
    stop: "Stop the active turn",
  };
  return descriptions[command] || "Run this session command";
}

async function executeCodexCommand(
  command: string,
  input: {
    sessionKey: string;
    threadId: string;
    cwd: string;
    activeTurnId: string | null;
    tokenUsage?: { total: number; input: number; output: number };
  },
): Promise<string | null> {
  const requestData = { sessionKey: input.sessionKey, threadId: input.threadId, cwd: input.cwd };
  if (command === "/compact") {
    await compactCodexThread(input.sessionKey, input.threadId, input.cwd);
    return "Compacting conversation context...";
  }
  if (command === "/review") {
    await startCodexReview(requestData);
    return "Reviewing uncommitted changes...";
  }
  if (command === "/stop") {
    if (!input.activeTurnId) return "No active Codex turn to stop.";
    await interruptCodexTurn(input.sessionKey, input.threadId, input.activeTurnId);
    return "Stopping the active Codex turn...";
  }
  if (command === "/status") return formatCodexStatus(await readCodexThreadStatus(requestData), input);
  if (command === "/skills") return formatCodexList(await listCodexSkills(requestData), "skills");
  if (command === "/mcp") return formatCodexList(await listCodexMcpServers(requestData), "MCP servers");
  return null;
}

function formatCodexStatus(
  result: Record<string, unknown>,
  input: { threadId: string; cwd: string; tokenUsage?: { total: number; input: number; output: number } },
): string {
  const thread = objectValue(result.thread);
  const config = objectValue(result.config);
  const rollout = objectValue(result.rollout);
  const session = objectValue(rollout.session);
  const context = objectValue(rollout.turnContext);
  const tokenInfo = objectValue(rollout.tokenInfo);
  const totalUsage = objectValue(tokenInfo.total_token_usage);
  const lastUsage = objectValue(tokenInfo.last_token_usage);
  const contextWindow = numberValue(tokenInfo.model_context_window);
  const sources = arrayStrings(result.instructionSources);
  const status = objectValue(thread.status).type;
  const model = stringValue(context.model, thread.model, thread.modelName, config.model, config.model_provider);
  const effort = stringValue(context.effort);
  const summary = stringValue(context.summary);
  const provider = stringValue(session.model_provider, thread.modelProvider);
  const providerConfig = objectValue(objectValue(config.model_providers)[provider || ""]);
  const providerUrl = stringValue(providerConfig.base_url, providerConfig.baseUrl);
  const approval = stringValue(context.approval_policy, thread.approvalPolicy, config.approval_policy, config.approvalPolicy);
  const sandboxPolicy = objectValue(context.sandbox_policy);
  const sandbox = stringValue(sandboxPolicy.type, thread.sandboxPolicy, config.sandbox_mode, config.sandboxMode);
  const writableRoots = arrayStrings(context.workspace_roots);
  const collab = stringValue(objectValue(context.collaboration_mode).mode);
  // Codex's status card counts billable input/output, not repeated cache hits.
  const usedTokens = numberValue(totalUsage.total_tokens)
    ? Math.max(0, numberValue(totalUsage.total_tokens)! - (numberValue(totalUsage.cached_input_tokens) || 0))
    : input.tokenUsage?.total;
  const inputTokens = numberValue(totalUsage.input_tokens) ?? input.tokenUsage?.input;
  const outputTokens = numberValue(totalUsage.output_tokens) ?? input.tokenUsage?.output;
  const currentPromptTokens = numberValue(lastUsage.input_tokens);
  const contextUsed = currentPromptTokens && contextWindow ? Math.min(currentPromptTokens, contextWindow) : undefined;
  const contextLeft = contextUsed !== undefined && contextWindow ? Math.max(0, contextWindow - contextUsed) : undefined;
  return [
    `Status: ${typeof status === "string" ? status : "idle"}`,
    model && `Model: ${model}${effort ? ` (reasoning ${effort}${summary ? `, summaries ${summary}` : ""})` : ""}`,
    provider && `Model provider: ${provider}${providerUrl ? ` - ${providerUrl}` : ""}`,
    `Directory: ${stringValue(context.cwd, input.cwd) || input.cwd}`,
    approval && `Permissions: ${formatPermissions(sandbox, approval)}`,
    writableRoots.length && `Writable roots: ${writableRoots.join(", ")}`,
    `Agents.md: ${sources.length ? sources.join(", ") : "<none>"}`,
    collab && `Collaboration mode: ${capitalize(collab)}`,
    `Session: ${input.threadId}`,
    usedTokens !== undefined && inputTokens !== undefined && outputTokens !== undefined
      && `Token usage: ${formatNumber(usedTokens)} total (${formatNumber(inputTokens)} input + ${formatNumber(outputTokens)} output)`,
    contextWindow && contextUsed !== undefined && contextLeft !== undefined
      && `Context window: ${Math.round((contextLeft / contextWindow) * 100)}% left (${formatNumber(contextUsed)} used / ${formatNumber(contextWindow)})`,
  ].filter((line): line is string => Boolean(line)).join("\n");
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

function formatNumber(value: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatPermissions(sandbox: string | null, approval: string): string {
  const sandboxLabel = sandbox === "workspace-write" ? "Workspace" : sandbox || "Custom";
  const approvalLabel = approval === "on-request" ? "Ask for approval" : approval;
  return `${sandboxLabel} (${approvalLabel})`;
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function formatCodexList(result: Record<string, unknown>, label: string): string {
  const data = Array.isArray(result.data) ? result.data : [];
  if (!data.length) return `No ${label} configured.`;
  const entries = data.slice(0, 30).map((entry) => {
    if (typeof entry === "string") return entry;
    if (typeof entry !== "object" || entry === null) return String(entry);
    const value = entry as Record<string, unknown>;
    return [value.name, value.id, value.displayName, value.status].find((part): part is string => typeof part === "string") || JSON.stringify(value);
  });
  return `${label[0].toUpperCase()}${label.slice(1)}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
}

function assistantText(message: Record<string, unknown>): string {
  const assistant = message.message;
  if (typeof assistant !== "object" || assistant === null || !("content" in assistant)) return "";
  const content = assistant.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function localCommandOutput(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = content.match(/<local-command-(?:stdout|stderr)>\s*([\s\S]*?)\s*<\/local-command-(?:stdout|stderr)>/);
  return match?.[1]?.trim() || "";
}
