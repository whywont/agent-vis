import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createTokenAccumulator, parseClaudeEvent } from "@/lib/claude-parser";
import { codexToolCallFromItem } from "@/lib/codex-parser";
import type { AppEvent } from "@/lib/types";
import {
  getActiveCodexTurn,
  getCodexThreadWriter,
  interruptCodexTurn,
  readAgentProviderRuntimeEvents,
  takeOverCodexThread,
  type AgentProviderRuntimeEvent,
  type CodexWriterInfo,
} from "./desktop-api";
import { getHarnessAdapter, type HarnessContext, type LiveProvider, type ModelOption } from "./harness-adapters";
import type { LiveStreamEntry } from "./DesktopLiveStream";
import InteractiveAgentRequestPanel from "./InteractiveAgentRequestPanel";
import { unappliedRuntimeEvents } from "./sequenced-runtime-events";
import type { InteractiveAgentRequest, InteractiveAgentResponse } from "./interactive-agent-requests";

type ConnectionState = "idle" | "connecting" | "ready" | "error";

type ImageAttachment = { id: string; url: string; name: string };
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export default function DesktopLiveConversation({
  provider,
  sessionKey,
  threadId,
  cwd,
  onApprovalChange,
  onContextCompaction,
  onTimelineEvent,
  onStreamEvent,
  onActivity,
  tokenUsage,
  visible = true,
  pinned = false,
  onNeedsAttention,
  initialDraft = "",
  onInitialDraftSent,
  onTurnCompleted,
}: {
  provider: LiveProvider;
  sessionKey: string;
  threadId: string;
  cwd: string;
  onApprovalChange?: (command: string | null) => void;
  onContextCompaction?: () => void;
  onTimelineEvent?: (event: AppEvent) => void;
  onStreamEvent?: (event: LiveStreamEntry) => void;
  onActivity?: () => void;
  tokenUsage?: { total: number; input: number; output: number };
  visible?: boolean;
  pinned?: boolean;
  onNeedsAttention?: () => void;
  initialDraft?: string;
  onInitialDraftSent?: () => void;
  onTurnCompleted?: () => void;
}) {
  const adapter = getHarnessAdapter(provider);
  const harnessContextRef = useRef<HarnessContext>({ sessionKey, threadId, cwd, activeTurnId: null, tokenUsage });
  harnessContextRef.current = { sessionKey, threadId, cwd, activeTurnId: null, tokenUsage };
  const [state, setState] = useState<ConnectionState>("idle");
  const [draft, setDraft] = useState(initialDraft);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  harnessContextRef.current.activeTurnId = activeTurnId;
  const [error, setError] = useState("");
  const [externalWriter, setExternalWriter] = useState<CodexWriterInfo | null>(null);
  const [takeControlConfirmation, setTakeControlConfirmation] = useState<{ threadId: string; pid: number } | null>(null);
  const [interactiveRequest, setInteractiveRequest] = useState<InteractiveAgentRequest | null>(null);
  const interactiveRequestRef = useRef<InteractiveAgentRequest | null>(null);
  const [respondingToRequest, setRespondingToRequest] = useState(false);
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [slashCommands, setSlashCommands] = useState(() => adapter.initialCommands.map((command) => command.id));
  const [slashSelection, setSlashSelection] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSelection, setModelSelection] = useState(0);
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [interrupted, setInterrupted] = useState(false);
  const pendingSlashCommand = useRef<{ command: string; callId: string; output: string } | null>(null);
  const connection = useRef<Promise<boolean> | null>(null);
  const reconnect = useRef<() => Promise<boolean>>(async () => false);
  const runtimeSequence = useRef({ scope: "", sequence: 0 });
  const slashInput = draft.startsWith("/") ? draft.slice(1).trimStart() : null;
  const slashQuery = slashInput?.split(/\s/, 1)[0].toLowerCase() ?? null;
  const matchingCommands = slashQuery === null ? [] : slashCommands.filter((command) => command.includes(slashQuery));
  const exactSlashCommand = slashQuery !== null && slashCommands.includes(slashQuery);
  const slashHasArguments = Boolean(slashInput && /\s/.test(slashInput));
  const showSlashPicker = matchingCommands.length > 0 && !slashHasArguments;
  useEffect(() => {
    if (interactiveRequest) onNeedsAttention?.();
  }, [interactiveRequest, onNeedsAttention]);

  useEffect(() => {
    interactiveRequestRef.current = interactiveRequest;
  }, [interactiveRequest]);

  useEffect(() => {
    if (!draft) composerRef.current?.style.removeProperty("height");
  }, [activeTurnId, draft]);

  useEffect(() => {
    // A continuation opens with a reviewable handoff draft. Attach now so the
    // status dot reflects the real harness state before the user sends it.
    if (initialDraft && state === "idle") void connect();
  }, [initialDraft, state]);

  useEffect(() => {
    if (provider !== "codex") return;
    let cancelled = false;
    void getActiveCodexTurn(sessionKey, threadId, cwd).then(({ turnId }) => {
      if (!cancelled && turnId) setActiveTurnId((current) => current || turnId);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [cwd, provider, sessionKey, threadId]);

  useEffect(() => {
    if (provider !== "codex" || !externalWriter) return;
    let cancelled = false;
    let timer: number | undefined;
    const recheck = async () => {
      try {
        const writer = await getCodexThreadWriter(threadId);
        if (cancelled) return;
        if (!writer) {
          setExternalWriter(null);
          setTakeControlConfirmation(null);
          setError("");
          setState("idle");
          connection.current = null;
          void reconnect.current();
          return;
        }
        if (writer.pid !== externalWriter.pid) {
          setExternalWriter(writer);
          setTakeControlConfirmation(null);
          setError(`Codex is open in another terminal (PID ${writer.pid}).`);
        }
      } catch {
        // Keep the confirmed owner visible if a transient inspection fails.
      }
      if (!cancelled) timer = window.setTimeout(recheck, 1000);
    };
    void recheck();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [externalWriter, provider, threadId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let catchingUp = true;
    const queuedLiveEvents: AgentProviderRuntimeEvent[] = [];
    const scope = `${provider}:${sessionKey}`;
    if (runtimeSequence.current.scope !== scope) {
      runtimeSequence.current = { scope, sequence: 0 };
    }

    const applyRuntimeEvent = (runtimeEvent: AgentProviderRuntimeEvent) => {
      if (runtimeEvent.sequence <= runtimeSequence.current.sequence) return;
      const message = asRecord(runtimeEvent.message);
      if (!message) return;
      runtimeSequence.current = { scope, sequence: runtimeEvent.sequence };
      onActivity?.();

      const activeInteractiveRequest = interactiveRequestRef.current;
      const completionResponse = adapter.interactiveRequests?.completionResponse?.(
        message,
        activeInteractiveRequest,
      );
      if (completionResponse && activeInteractiveRequest && adapter.interactiveRequests) {
        setRespondingToRequest(true);
        void adapter.interactiveRequests.respond(
          harnessContextRef.current,
          activeInteractiveRequest,
          completionResponse,
        ).then(() => {
          if (interactiveRequestRef.current?.requestId !== activeInteractiveRequest.requestId) return;
          interactiveRequestRef.current = null;
          setInteractiveRequest(null);
          onApprovalChange?.(null);
        }).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => setRespondingToRequest(false));
      }
      if (!completionResponse && adapter.interactiveRequests?.isResolved?.(message, activeInteractiveRequest)) {
        interactiveRequestRef.current = null;
        setInteractiveRequest(null);
        setRespondingToRequest(false);
        onApprovalChange?.(null);
      }
      const serverRequest = adapter.interactiveRequests?.decode(message);
      if (serverRequest?.type === "unsupported") {
        setState("error");
        setError(`${serverRequest.description} Agent Vis rejected ${serverRequest.method} so the turn will not hang.`);
        return;
      }
      if (serverRequest) {
        interactiveRequestRef.current = serverRequest;
        setInteractiveRequest(serverRequest);
        onApprovalChange?.(serverRequest.type === "approval" ? serverRequest.command || null : null);
      }

      if (provider === "claude-code") {
        if (message.type === "agent-vis/disconnected") {
          setInteractiveRequest(null);
          setRespondingToRequest(false);
          onApprovalChange?.(null);
          setState("error");
          setError("Claude disconnected");
          setActiveTurnId(null);
          return;
        }
        if (message.type === "system" && message.status === "requesting") {
          setActiveTurnId("claude-turn");
          onStreamEvent?.(streamEntry("system", "Claude is working."));
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
        if (message.type === "assistant") {
          const output = assistantText(message);
          if (output) onStreamEvent?.(streamEntry("assistant", output));
          for (const event of parseClaudeEvent(message, createTokenAccumulator())) {
            if (event.kind === "tool_call") {
              onTimelineEvent?.({ ...event, ts: event.ts || new Date().toISOString() });
            }
          }
        }
        if (message.type === "result") {
          setInteractiveRequest(null);
          setRespondingToRequest(false);
          onApprovalChange?.(null);
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
          onStreamEvent?.(streamEntry("system", message.subtype === "success" ? "Claude finished." : "Claude stopped."));
          if (message.subtype !== "success") {
            setState("error");
            setError(typeof message.result === "string" ? message.result : "Claude could not complete this turn.");
          } else {
            setState("ready");
          }
          onTurnCompleted?.();
        }
        return;
      }

      const method = typeof message.method === "string" ? message.method : undefined;
      const params = asRecord(message.params) || {};
      if (method === "agent-vis/disconnected") {
        setInteractiveRequest(null);
        setRespondingToRequest(false);
        onApprovalChange?.(null);
        setState("error");
        setError("Codex disconnected");
        return;
      }
      if (method === "turn/started") {
        const turn = params.turn as { id?: string } | undefined;
        setActiveTurnId(turn?.id || null);
        setInterrupted(false);
        onStreamEvent?.(streamEntry("system", "Codex is working.", `codex:turn:${turn?.id || "current"}:started`));
      }
      if (method === "turn/completed") {
        setInteractiveRequest(null);
        setRespondingToRequest(false);
        onApprovalChange?.(null);
        setActiveTurnId(null);
        const turn = params.turn as { id?: string; status?: string; error?: { message?: string } | string } | undefined;
        const error = typeof turn?.error === "string"
          ? turn.error
          : turn?.error?.message;
        if (turn?.status === "failed" || error) {
          setState("error");
          setError(error || "Codex could not complete this turn.");
        }
        onStreamEvent?.(streamEntry(
          "system",
          turn?.status === "completed" ? "Codex finished." : "Codex stopped.",
          `codex:turn:${turn?.id || "current"}:completed`,
        ));
        onTurnCompleted?.();
      }
      if (method === "thread/status/changed") {
        const status = params.status as { type?: string } | undefined;
        if (status?.type === "idle") setActiveTurnId(null);
      }
      if (method === "item/started" && isCodexCompaction(params.item)) {
        onContextCompaction?.();
      }
      if (method === "item/started") {
        const toolCall = codexToolCallFromItem(params.item, new Date().toISOString());
        if (toolCall) onTimelineEvent?.(toolCall);
      }
      const streamEvent = codexStreamEvent(method, params);
      if (streamEvent) onStreamEvent?.(streamEvent);
    };

    void listen<AgentProviderRuntimeEvent>("agent-provider-runtime-event", (event) => {
      const runtimeEvent = event.payload;
      if (runtimeEvent.providerInstanceId !== provider || runtimeEvent.sessionKey !== sessionKey) return;
      if (catchingUp) queuedLiveEvents.push(runtimeEvent);
      else applyRuntimeEvent(runtimeEvent);
    }).then(async (stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
      const afterSequence = runtimeSequence.current.sequence || undefined;
      try {
        const replay = await readAgentProviderRuntimeEvents(provider, sessionKey, afterSequence);
        if (cancelled) return;
        if (replay.resetRequired) {
          runtimeSequence.current = { scope, sequence: replay.oldestAvailableSequence - 1 };
          onTurnCompleted?.();
        }
        for (const runtimeEvent of unappliedRuntimeEvents(runtimeSequence.current.sequence, replay.events)) {
          applyRuntimeEvent(runtimeEvent);
        }
      } catch {
        // The live subscription remains useful if catch-up is unavailable
        // during a backend restart. Its first event establishes the watermark.
      } finally {
        catchingUp = false;
        if (!cancelled) {
          for (const runtimeEvent of unappliedRuntimeEvents(runtimeSequence.current.sequence, queuedLiveEvents)) {
            applyRuntimeEvent(runtimeEvent);
          }
        }
        queuedLiveEvents.length = 0;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [adapter.interactiveRequests, onActivity, onApprovalChange, onContextCompaction, onStreamEvent, onTimelineEvent, onTurnCompleted, provider, sessionKey]);

  async function connect(): Promise<boolean> {
    if (connection.current) return connection.current;
    const attempt = (async () => {
      setState("connecting");
      setError("");
      try {
        await adapter.connect({ sessionKey, threadId, cwd, activeTurnId, tokenUsage });
        setModelOptions(await adapter.models({ sessionKey, threadId, cwd, activeTurnId, tokenUsage }));
        setExternalWriter(null);
        setState("ready");
        return true;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (provider === "codex" && message.includes("already has an active writer")) {
          try {
            const writer = await getCodexThreadWriter(threadId);
            setExternalWriter(writer);
            setError(writer
              ? `Codex is open in another terminal (PID ${writer.pid}).`
              : "Codex is open in another process. Close it before taking control here.");
          } catch (inspectionError) {
            setExternalWriter(null);
            setError(inspectionError instanceof Error ? inspectionError.message : String(inspectionError));
          }
        } else {
          setExternalWriter(null);
          setError(message);
        }
        setState("error");
        return false;
      } finally {
        connection.current = null;
      }
    })();
    connection.current = attempt;
    return attempt;
  }
  reconnect.current = connect;

  async function submit(textOverride?: string, alreadyConnected = false) {
    const text = (textOverride ?? draft).trim();
    if ((!text && !images.length) || sending) return;
    if (text === "/model") {
      if (!modelOptions.length) {
        try {
          setModelOptions(await adapter.models({ sessionKey, threadId, cwd, activeTurnId, tokenUsage }));
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
    if (!alreadyConnected && state !== "ready" && !(await connect())) {
      setSending(false);
      return;
    }
    try {
      const imageUrls = images.map((image) => image.url);
      const streamInput = text || `${imageUrls.length} image attachment${imageUrls.length === 1 ? "" : "s"}`;
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
      if (isSlashCommand && adapter.executeCommand && imageUrls.length === 0) {
        const output = await adapter.executeCommand(text, { sessionKey, threadId, cwd, activeTurnId, tokenUsage });
        if (output && callId) {
          onTimelineEvent?.({ kind: "tool_output", ts: new Date().toISOString(), callId, output });
        }
      } else {
        await adapter.sendTurn({ sessionKey, threadId, cwd, activeTurnId, tokenUsage }, text, imageUrls);
        // Do not show a local input as delivered until the harness has accepted
        // it; otherwise a rejected request becomes a misleading ghost entry.
        onTimelineEvent?.({
          kind: "user_message",
          ts: new Date().toISOString(),
          text,
          ...(imageUrls.length ? { images: imageUrls } : {}),
        });
        onStreamEvent?.(streamEntry("input", streamInput));
        if (provider === "codex" && !activeTurnId) {
          // The app-server's turn/started notification normally replaces this
          // immediately. It keeps Steer visibly ready if that notification is
          // delayed; it is deliberately not passed back as a real turn ID.
          setActiveTurnId("pending-turn");
          setInterrupted(false);
        }
        // A continuation handoff is a one-time composer seed. Users often
        // edit it before sending, so consume it after the first normal turn.
        if (initialDraft) onInitialDraftSent?.();
        if (provider === "claude-code") {
        // Claude's stream reports completion as a result frame. Mark it busy
        // immediately so the shared status glyph cannot lag behind the send.
          setActiveTurnId("claude-turn");
        }
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

  async function takeControlAndRetry() {
    if (!externalWriter || sending) return;
    setTakeControlConfirmation(null);
    setSending(true);
    setError("");
    setState("connecting");
    try {
      await takeOverCodexThread(threadId, externalWriter.pid);
      setExternalWriter(null);
      connection.current = null;
      if (!(await connect())) {
        setSending(false);
        return;
      }
      await submit(undefined, true);
      setSending(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
      setSending(false);
    }
  }

  async function interruptActiveTurn() {
    if (provider !== "codex" || !activeTurnId || activeTurnId === "pending-turn") return;
    try {
      await interruptCodexTurn(sessionKey, threadId, activeTurnId);
      setInterrupted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

  async function respondToInteractiveRequest(response: InteractiveAgentResponse) {
    if (!interactiveRequest || !adapter.interactiveRequests || respondingToRequest) return;
    setRespondingToRequest(true);
    try {
      await adapter.interactiveRequests.respond(
        { sessionKey, threadId, cwd, activeTurnId, tokenUsage },
        interactiveRequest,
        response,
      );
      interactiveRequestRef.current = null;
      setInteractiveRequest(null);
      onApprovalChange?.(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRespondingToRequest(false);
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
    try {
      const result = await adapter.selectModel({ sessionKey, threadId, cwd, activeTurnId, tokenUsage }, model);
      if (result.type === "send") {
        void submit(result.command);
        return;
      }
      onTimelineEvent?.({
        kind: "shell_command",
        ts: new Date().toISOString(),
        cmd: command,
        workdir: cwd,
        toolName: "local_command",
        description: `${adapter.label} session command`,
      });
      onTimelineEvent?.({
        kind: "tool_output",
        ts: new Date().toISOString(),
        output: result.output,
      });
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className={`desktop-codex-live-strip${pinned ? " is-pinned" : ""}${visible ? "" : " is-hidden"}`} aria-label={`Message ${adapter.label}`}>
      <div className={`desktop-codex-live-bar${images.length ? " has-images" : ""}`}>
        {provider === "codex" && activeTurnId ? (
          <button
            type="button"
            className="desktop-codex-live-interrupt"
            onClick={() => void interruptActiveTurn()}
            title="Stop Codex (Esc)"
            aria-label="Stop Codex"
          >
            <span aria-hidden="true" />
          </button>
        ) : provider === "codex" && interrupted ? (
          <span className="desktop-codex-live-resume" title="Codex turn interrupted" aria-label="Codex turn interrupted">
            <span aria-hidden="true" />
          </span>
        ) : (
          <span
            className={`desktop-codex-live-dot ${interactiveRequest ? "running" : state}`}
            aria-label={interactiveRequest ? `${adapter.label} needs input` : `${adapter.label} ready`}
            role="status"
          />
        )}
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
            if (!externalWriter && state !== "ready" && state !== "connecting") void connect();
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
            if (event.key === "Escape" && activeTurnId && provider === "codex") {
              event.preventDefault();
              void interruptActiveTurn();
              return;
            }
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
                <span>{adapter.commandDescription(command)}</span>
              </button>
            ))}
          </div>
        )}
        {modelPickerOpen && modelOptions.length > 0 && (
          <div className="desktop-slash-picker desktop-model-picker" role="listbox" aria-label="Choose model">
            <header>Choose {adapter.label} model</header>
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
        {externalWriter ? (
          <button
            type="button"
            className="desktop-codex-take-control"
            onClick={() => setTakeControlConfirmation({ threadId, pid: externalWriter.pid })}
            disabled={sending}
            title={`Exit Codex PID ${externalWriter.pid}, resume this thread in Agent Vis, and send the current message`}
          >
            {sending ? "Taking control..." : "Take control"}
          </button>
        ) : (
          <button type="button" onClick={() => void submit()} disabled={(!draft.trim() && !images.length) || sending}>
            {sending || state === "connecting" ? "Opening..." : activeTurnId ? "Steer" : "Send"}
          </button>
        )}
        {error && <span className="desktop-codex-live-error" title={error}>{error}</span>}
        {externalWriter
          && takeControlConfirmation?.threadId === threadId
          && takeControlConfirmation.pid === externalWriter.pid
          && !sending && (
          <div className="desktop-codex-take-control-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm Codex takeover">
            <span>
              Exit Codex PID {externalWriter.pid}? Its terminal will return to the shell and any in-flight work there will stop. History is preserved.
            </span>
            <button type="button" className="danger" onClick={() => void takeControlAndRetry()}>
              Exit and resume here
            </button>
            <button type="button" onClick={() => setTakeControlConfirmation(null)}>Cancel</button>
          </div>
        )}
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
      {interactiveRequest && (
        <InteractiveAgentRequestPanel
          key={`${provider}:${String(interactiveRequest.requestId)}`}
          request={interactiveRequest}
          responding={respondingToRequest}
          onRespond={(response) => void respondToInteractiveRequest(response)}
        />
      )}
    </section>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function streamEntry(kind: LiveStreamEntry["kind"], text: string, id: string = crypto.randomUUID()): LiveStreamEntry {
  return { id, kind, text, ts: new Date().toISOString() };
}

function codexStreamEvent(method: string | undefined, params: Record<string, unknown>): LiveStreamEntry | null {
  if (!method) return null;
  const item = params.item;
  if (method === "item/started" || method === "item/completed") {
    const formatted = formatCodexItem(item, method === "item/completed");
    return formatted ? streamEntry(formatted.kind, formatted.text, `codex:${formatted.id}`) : null;
  }
  const delta = typeof params.delta === "string" ? params.delta : "";
  const itemId = typeof params.itemId === "string" ? params.itemId : "";
  if (!delta || !itemId) return null;
  if (method.includes("agentMessage")) return { ...streamEntry("assistant", delta, `codex:${itemId}`), append: true };
  if (method.includes("reasoning")) return { ...streamEntry("reasoning", delta, `codex:${itemId}`), append: true };
  if (method.includes("commandExecution")) return { ...streamEntry("output", delta, `codex:${itemId}`), append: true };
  return null;
}

function formatCodexItem(item: unknown, completed = false): { id: string; kind: LiveStreamEntry["kind"]; text: string } | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : crypto.randomUUID();
  const type = typeof record.type === "string" ? record.type : "";
  const text = stringValue(record.text) || stringValue(record.content) || stringValue(record.command) || stringValue(record.query);
  if (type === "agentMessage" && text) return { id, kind: "assistant", text };
  if (type === "reasoning" && text) return { id, kind: "reasoning", text };
  if (type === "commandExecution") {
    if (completed) {
      const output = stringValue(record.aggregatedOutput);
      const status = stringValue(record.status);
      const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
      if (output) return { id: `${id}:result`, kind: "output", text: boundedCommandOutput(output) };
      if (status === "failed" || (exitCode !== null && exitCode !== 0)) {
        return {
          id: `${id}:result`,
          kind: "output",
          text: `Command failed${exitCode === null ? "." : ` with exit code ${exitCode}.`}`,
        };
      }
      return null;
    }
    return { id, kind: "tool", text: text ? `$ ${text}` : "Running command..." };
  }
  if (type === "fileChange") return { id, kind: "tool", text: "Applying file changes..." };
  if (type === "webSearch") return { id, kind: "tool", text: text ? `Searching: ${text}` : "Searching the web..." };
  return null;
}

function boundedCommandOutput(output: string): string {
  const maxCharacters = 12_000;
  if (output.length <= maxCharacters) return output;
  return `[Earlier command output omitted]\n${output.slice(-maxCharacters)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
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
