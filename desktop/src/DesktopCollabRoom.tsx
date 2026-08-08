import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionMeta } from "@/lib/types";
import { collabDispatchPrompt } from "./collab-state";
import {
  acquireCollabLease,
  addCollabWorker,
  claimCollabTask,
  connectClaudeThread,
  connectCodexThread,
  createCollabTask,
  getCollabRoomState,
  integrateCollabChange,
  listCodexModels,
  postCollabAgentMessage,
  postCollabDirectMessage,
  postCollabMessage,
  releaseCollabLease,
  renewCollabLease,
  reviewCollabChange,
  sendClaudeTurn,
  sendCodexTurn,
  startClaudeSession,
  startCodexSession,
  submitCollabChange,
  updateCollabWorkerRuntime,
  type CollabRoomState,
  type CollabWorker,
  type CodexModel,
} from "./desktop-api";
import { CLAUDE_EFFORT_OPTIONS, CLAUDE_MODEL_OPTIONS, type EffortOption, type ModelOption } from "./harness-adapters";

interface CodexRuntimeEvent {
  sessionKey: string;
  message: { method?: string; params?: Record<string, unknown> };
}

interface ClaudeRuntimeEvent {
  sessionKey: string;
  message: Record<string, unknown>;
}

type AgentStreamEntry = {
  id: string;
  kind: "assistant" | "reasoning" | "tool" | "system";
  text: string;
};

export default function DesktopCollabRoom({
  session,
  openWorkerIds,
  activeWorkerId,
  onWorkerViewChange,
}: {
  session: SessionMeta;
  openWorkerIds: string[];
  activeWorkerId: string | null;
  onWorkerViewChange: (openWorkerIds: string[], activeWorkerId: string | null) => void;
}) {
  const roomRef = session.file;
  const [state, setState] = useState<CollabRoomState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [groupDraft, setGroupDraft] = useState("");
  const [directDrafts, setDirectDrafts] = useState<Record<string, string>>({});
  const [coordinationOpen, setCoordinationOpen] = useState(false);
  const [workerName, setWorkerName] = useState("");
  const [provider, setProvider] = useState("codex");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("default");
  const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
  const [effortOptions, setEffortOptions] = useState<readonly EffortOption[]>([]);
  const [codexModels, setCodexModels] = useState<readonly CodexModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskScope, setTaskScope] = useState("");
  const [leaseWorker, setLeaseWorker] = useState("");
  const [leaseResource, setLeaseResource] = useState("");
  const [submissionTitle, setSubmissionTitle] = useState("");
  const [submissionSummary, setSubmissionSummary] = useState("");
  const [groupColumnWidth, setGroupColumnWidth] = useState<number | null>(null);
  const [, setStreams] = useState<Record<string, AgentStreamEntry[]>>({});
  const stateRef = useRef<CollabRoomState | null>(null);
  const conversationsRef = useRef<HTMLDivElement>(null);
  const responseBuffers = useRef(new Map<string, string>());
  const pendingChannels = useRef(new Map<string, Array<"group" | "private">>());
  const reconnectAttempts = useRef(new Set<string>());

  const updateState = useCallback((next: CollabRoomState) => {
    stateRef.current = next;
    setState(next);
    window.dispatchEvent(new CustomEvent("collab-room-state-changed", { detail: next.roomId }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      updateState(await getCollabRoomState(roomRef));
      setError("");
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setLoading(false);
    }
  }, [roomRef, updateState]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => {
    const toggleCoordination = () => setCoordinationOpen((open) => !open);
    window.addEventListener("toggle-collab-coordination", toggleCoordination);
    return () => window.removeEventListener("toggle-collab-coordination", toggleCoordination);
  }, []);
  useEffect(() => {
    if (!coordinationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCoordinationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [coordinationOpen]);

  useEffect(() => {
    if (provider !== "codex") return;
    const timer = window.setTimeout(() => {
      setModelsLoading(true);
      const sessionKey = `collab:model-picker:${crypto.randomUUID()}`;
      void listCodexModels(sessionKey, "", session.cwd)
        .then((models) => {
          setCodexModels(models);
          setModelOptions(models.map((item): ModelOption => [
            item.id || item.model || "",
            item.description || item.displayName || "Codex model",
          ]).filter(([id]) => Boolean(id)));
          const selected = models.find((item) => item.isDefault) || models[0];
          setModel(selected?.id || selected?.model || "");
          setEffortOptions(codexEfforts(selected));
        })
        .catch((reason: unknown) => setError(errorText(reason)))
        .finally(() => setModelsLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [provider, session.cwd]);

  function chooseWorkerModel(nextModel: string) {
    setModel(nextModel);
    if (provider !== "codex") return;
    const selected = codexModels.find((item) => (item.id || item.model) === nextModel);
    setEffortOptions(codexEfforts(selected));
    setEffort("default");
  }

  function chooseWorkerProvider(nextProvider: string) {
    setProvider(nextProvider);
    setEffort("default");
    setCodexModels([]);
    if (nextProvider === "claude") {
      setModelOptions(CLAUDE_MODEL_OPTIONS);
      setModel("default");
      setEffortOptions(CLAUDE_EFFORT_OPTIONS);
    } else {
      setModel("");
      setModelOptions([]);
      setEffortOptions([]);
    }
  }

  const appendStream = useCallback((workerId: string, entry: AgentStreamEntry, append = false) => {
    setStreams((current) => {
      const entries = current[workerId] || [];
      const last = entries.at(-1);
      const next = append && last?.id === entry.id
        ? [...entries.slice(0, -1), { ...last, text: `${last.text}${entry.text}` }]
        : [...entries, entry];
      return { ...current, [workerId]: next.slice(-150) };
    });
  }, []);

  const startWorker = useCallback(async (worker: CollabWorker) => {
    if (!supportsRuntime(worker)) return;
    reconnectAttempts.current.add(worker.id);
    updateState(await updateCollabWorkerRuntime(roomRef, worker.id, worker.sessionKey, worker.threadId, "starting"));
    try {
      let sessionKey = worker.sessionKey;
      let threadId = worker.threadId;
      if (sessionKey && threadId) {
        if (worker.provider === "codex") await connectCodexThread(sessionKey, threadId, worker.worktreePath);
        else await connectClaudeThread(sessionKey, threadId, worker.worktreePath);
      } else {
        sessionKey = `collab:${session.id}:${worker.id}`;
        if (worker.provider === "codex") threadId = (await startCodexSession(sessionKey, worker.worktreePath, worker.model, worker.effort)).id;
        else {
          const requestedId = crypto.randomUUID();
          threadId = await startClaudeSession(sessionKey, requestedId, worker.worktreePath, worker.model || "default", worker.effort);
        }
      }
      updateState(await updateCollabWorkerRuntime(roomRef, worker.id, sessionKey, threadId, "running"));
    } catch (nextError) {
      const detail = errorText(nextError);
      updateState(await updateCollabWorkerRuntime(roomRef, worker.id, worker.sessionKey, worker.threadId, "error", detail));
      setError(detail);
    }
  }, [roomRef, session.id, updateState]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const workerForSession = (sessionKey: string) => stateRef.current?.workers.find((worker) => worker.sessionKey === sessionKey);
    const recordReply = async (sessionKey: string, text: string) => {
      const worker = workerForSession(sessionKey);
      const channels = pendingChannels.current.get(sessionKey) || [];
      const channel = channels.shift() || "private";
      if (channels.length) pendingChannels.current.set(sessionKey, channels);
      else pendingChannels.current.delete(sessionKey);
      const reply = text.trim();
      if (!worker || !reply) return;
      try {
        const next = await postCollabAgentMessage(roomRef, worker, reply, channel === "private");
        if (!cancelled) updateState(next);
      } catch (nextError) {
        if (!cancelled) setError(errorText(nextError));
      }
    };
    void listen<CodexRuntimeEvent>("codex-app-server-event", (event) => {
      const { sessionKey, message } = event.payload;
      const worker = workerForSession(sessionKey);
      if (!worker) return;
      const params = message.params || {};
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : crypto.randomUUID();
      if (message.method?.includes("agentMessage") && delta) {
        responseBuffers.current.set(sessionKey, `${responseBuffers.current.get(sessionKey) || ""}${delta}`);
        appendStream(worker.id, { id: `assistant:${itemId}`, kind: "assistant", text: delta }, true);
      } else if (message.method?.includes("reasoning") && delta) {
        appendStream(worker.id, { id: `reasoning:${itemId}`, kind: "reasoning", text: delta }, true);
      } else if (message.method?.includes("commandExecution") && delta) {
        appendStream(worker.id, { id: `tool:${itemId}`, kind: "tool", text: delta }, true);
      }
      if (message.method === "item/completed") {
        const text = codexAgentText(params.item);
        if (text) responseBuffers.current.set(sessionKey, text);
        const tool = codexToolText(params.item);
        if (tool) appendStream(worker.id, { id: `tool:${itemId}:complete`, kind: "tool", text: tool });
      }
      if (message.method === "turn/started") appendStream(worker.id, { id: crypto.randomUUID(), kind: "system", text: "Working" });
      if (message.method === "turn/completed") {
        const reply = responseBuffers.current.get(sessionKey) || "";
        responseBuffers.current.delete(sessionKey);
        appendStream(worker.id, { id: crypto.randomUUID(), kind: "system", text: "Turn complete" });
        void recordReply(sessionKey, reply);
      }
      if (message.method === "agent-vis/disconnected") void markWorkerDisconnected(roomRef, worker, updateState, setError);
    }).then((unlisten) => cancelled ? unlisten() : unlisteners.push(unlisten));
    void listen<ClaudeRuntimeEvent>("claude-stream-event", (event) => {
      const { sessionKey, message } = event.payload;
      const worker = workerForSession(sessionKey);
      if (!worker) return;
      if (message.type === "assistant") {
        const text = claudeAssistantText(message);
        if (text) {
          responseBuffers.current.set(sessionKey, text);
          appendStream(worker.id, { id: `assistant:${crypto.randomUUID()}`, kind: "assistant", text });
        }
      }
      if (message.type === "system" && message.status === "requesting") appendStream(worker.id, { id: crypto.randomUUID(), kind: "system", text: "Working" });
      if (message.type === "result") {
        const reply = responseBuffers.current.get(sessionKey) || (typeof message.result === "string" ? message.result : "");
        responseBuffers.current.delete(sessionKey);
        appendStream(worker.id, { id: crypto.randomUUID(), kind: "system", text: "Turn complete" });
        void recordReply(sessionKey, reply);
      }
      if (message.type === "agent-vis/disconnected") void markWorkerDisconnected(roomRef, worker, updateState, setError);
    }).then((unlisten) => cancelled ? unlisten() : unlisteners.push(unlisten));
    return () => { cancelled = true; unlisteners.forEach((unlisten) => unlisten()); };
  }, [appendStream, roomRef, updateState]);

  useEffect(() => {
    if (!state) return;
    const reconnectable = state.workers.filter((worker) =>
      supportsRuntime(worker)
      && Boolean(worker.sessionKey && worker.threadId)
      && (worker.runtimeStatus === "running" || worker.runtimeStatus === "error")
      && !reconnectAttempts.current.has(worker.id));
    if (!reconnectable.length) return;
    const timer = window.setTimeout(() => {
      for (const worker of reconnectable) void startWorker(worker);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [startWorker, state]);

  const openWorkers = openWorkerIds.flatMap((workerId) => {
    const worker = state?.workers.find((candidate) => candidate.id === workerId);
    return worker ? [worker] : [];
  });
  const groupMessages = state?.messages.filter((item) => !item.recipientId) || [];
  const workerNames = useMemo(() => new Map(state?.workers.map((worker) => [worker.id, worker.name]) || []), [state?.workers]);

  if (loading) return <div className="desktop-collab-room desktop-collab-loading">Opening room...</div>;
  if (!state) return <div className="desktop-collab-room desktop-collab-loading error">{error || "Unable to open room."}</div>;
  const selectedLeaseWorker = leaseWorker || state.workers[0]?.id || "";

  async function mutate(operation: () => Promise<CollabRoomState>) {
    setBusy(true);
    setError("");
    try { updateState(await operation()); return true; }
    catch (nextError) { setError(errorText(nextError)); return false; }
    finally { setBusy(false); }
  }

  async function sendToWorker(worker: CollabWorker, body: string, channel: "group" | "private", roomState = stateRef.current) {
    if (!worker.sessionKey || !worker.threadId) throw new Error(`${worker.name} is not running.`);
    if (!roomState) throw new Error("Collaboration state is unavailable.");
    const prompt = collabDispatchPrompt(roomState, worker, body, channel);
    const channels = pendingChannels.current.get(worker.sessionKey) || [];
    pendingChannels.current.set(worker.sessionKey, [...channels, channel]);
    try {
      if (worker.provider === "codex") await sendCodexTurn(worker.sessionKey, worker.threadId, null, prompt, []);
      else await sendClaudeTurn(worker.sessionKey, prompt, []);
    } catch (nextError) {
      const pending = pendingChannels.current.get(worker.sessionKey) || [];
      pending.pop();
      if (pending.length) pendingChannels.current.set(worker.sessionKey, pending);
      else pendingChannels.current.delete(worker.sessionKey);
      throw nextError;
    }
  }

  async function sendGroup(event: FormEvent) {
    event.preventDefault();
    const body = groupDraft.trim();
    if (!body) return;
    setBusy(true);
    setError("");
    try {
      const next = await postCollabMessage(roomRef, body);
      updateState(next);
      setGroupDraft("");
      const running = next.workers.filter((worker) => worker.runtimeStatus === "running" && supportsRuntime(worker));
      const results = await Promise.allSettled(running.map((worker) => sendToWorker(worker, body, "group", next)));
      const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
      if (failures.length) setError(failures.map((failure) => errorText(failure.reason)).join("\n"));
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  }

  async function sendDirect(event: FormEvent, worker: CollabWorker) {
    event.preventDefault();
    const body = (directDrafts[worker.id] || "").trim();
    if (!body) return;
    setBusy(true);
    setError("");
    try {
      const next = await postCollabDirectMessage(roomRef, worker.id, body);
      updateState(next);
      setDirectDrafts((current) => ({ ...current, [worker.id]: "" }));
      if (supportsRuntime(worker)) await sendToWorker(worker, body, "private", next);
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  }

  function closeWorker(workerId: string) {
    const next = openWorkerIds.filter((id) => id !== workerId);
    const nextActive = activeWorkerId === workerId ? next.at(-1) || null : activeWorkerId;
    onWorkerViewChange(next, nextActive);
  }

  function activateWorker(workerId: string) {
    const next = openWorkerIds.includes(workerId) ? openWorkerIds : [...openWorkerIds, workerId].slice(-2);
    onWorkerViewChange(next, workerId);
  }

  function resizeConversationColumns(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const conversations = conversationsRef.current;
    if (!conversations) return;
    event.preventDefault();
    const bounds = conversations.getBoundingClientRect();
    const handleWidth = 6;
    const minimumColumnWidth = Math.min(360, Math.max(240, (bounds.width - handleWidth) * 0.35));
    document.body.classList.add("resizing");
    function onMove(moveEvent: MouseEvent) {
      const available = bounds.width - handleWidth;
      setGroupColumnWidth(Math.max(minimumColumnWidth, Math.min(available - minimumColumnWidth, moveEvent.clientX - bounds.left)));
    }
    function onUp() {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  async function addWorker(event: FormEvent) {
    event.preventDefault();
    const known = new Set(stateRef.current?.workers.map((worker) => worker.id) || []);
    if (!await mutate(() => addCollabWorker(roomRef, workerName, provider, model, effort, provider === "human" ? "collaborator" : "agent worker"))) return;
    setWorkerName("");
    const worker = stateRef.current?.workers.find((candidate) => !known.has(candidate.id));
    if (worker && supportsRuntime(worker)) await startWorker(worker);
  }

  return <section className={`desktop-collab-room desktop-collab-chat-layout${openWorkers.length ? " direct-open" : ""}${openWorkers.length > 1 ? " multi-direct-open" : ""}`}>
    <button className="desktop-collab-coordination-fallback" type="button" onClick={() => setCoordinationOpen((open) => !open)}>Coordination</button>
    {error && <div className="desktop-collab-error" role="alert">{error}</div>}
    <div className="desktop-collab-conversations" ref={conversationsRef} style={groupColumnWidth === null ? undefined : { "--desktop-collab-group-width": `${groupColumnWidth}px` } as CSSProperties}>
      <ConversationPane online={state.workers.filter((worker) => worker.runtimeStatus === "running").length} messages={groupMessages} draft={groupDraft} onDraft={setGroupDraft} onSubmit={sendGroup} busy={busy} placeholder="Message the room..." />
      <div className="desktop-collab-column-resize" role="separator" aria-label="Resize group and private chats" aria-orientation="vertical" onMouseDown={resizeConversationColumns} />
      <aside className={`desktop-collab-agent-rail${openWorkers.length > 1 ? " multi" : ""}`}>
        {openWorkers.length > 0 && <div className="desktop-collab-open-agent-panes">{openWorkers.map((worker) => <DirectPane key={worker.id} worker={worker} active={worker.id === activeWorkerId} messages={state.messages.filter((message) => (message.authorId === "local-host" && message.recipientId === worker.id) || (message.authorId === worker.id && message.recipientId === "local-host"))} draft={directDrafts[worker.id] || ""} onDraft={(value) => setDirectDrafts((current) => ({ ...current, [worker.id]: value }))} onSubmit={(event) => void sendDirect(event, worker)} onActivate={() => activateWorker(worker.id)} onPublish={(message) => void mutate(() => postCollabAgentMessage(roomRef, worker, message.body, false))} onClose={() => closeWorker(worker.id)} onStart={() => void startWorker(worker)} busy={busy} />)}</div>}
        {openWorkers.length < 2 && <AgentRoster workers={state.workers} workerName={workerName} setWorkerName={setWorkerName} provider={provider} setProvider={chooseWorkerProvider} model={model} setModel={chooseWorkerModel} effort={effort} setEffort={setEffort} modelOptions={modelOptions} effortOptions={effortOptions} modelsLoading={modelsLoading} onAddWorker={addWorker} onSelect={activateWorker} onStart={(worker) => void startWorker(worker)} busy={busy} />}
      </aside>
    </div>
    {coordinationOpen && <div className="desktop-collab-coordination-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCoordinationOpen(false); }}><CoordinationDrawer onClose={() => setCoordinationOpen(false)} state={state} busy={busy} workerNames={workerNames} taskTitle={taskTitle} setTaskTitle={setTaskTitle} taskScope={taskScope} setTaskScope={setTaskScope} leaseWorker={selectedLeaseWorker} setLeaseWorker={setLeaseWorker} leaseResource={leaseResource} setLeaseResource={setLeaseResource} submissionTitle={submissionTitle} setSubmissionTitle={setSubmissionTitle} submissionSummary={submissionSummary} setSubmissionSummary={setSubmissionSummary} onCreateTask={(event) => { event.preventDefault(); void mutate(() => createCollabTask(roomRef, taskTitle, taskScope)).then((ok) => { if (ok) { setTaskTitle(""); setTaskScope(""); } }); }} onClaimTask={(taskId, workerId) => void mutate(() => claimCollabTask(roomRef, taskId, workerId))} onAcquireLease={(event) => { event.preventDefault(); void mutate(() => acquireCollabLease(roomRef, selectedLeaseWorker, null, leaseResource, "exclusive", 900)).then((ok) => { if (ok) setLeaseResource(""); }); }} onRenewLease={(lease) => void mutate(() => renewCollabLease(roomRef, lease))} onReleaseLease={(lease) => void mutate(() => releaseCollabLease(roomRef, lease))} onSubmitChange={(event) => { event.preventDefault(); if (!selectedLeaseWorker) return; void mutate(() => submitCollabChange(roomRef, selectedLeaseWorker, submissionTitle, submissionSummary, state.leases)).then((ok) => { if (ok) { setSubmissionTitle(""); setSubmissionSummary(""); } }); }} onReview={(id, decision) => void mutate(() => reviewCollabChange(roomRef, id, decision, decision === "approved" ? "Approved by host" : "Changes requested"))} onIntegrate={(id) => void mutate(() => integrateCollabChange(roomRef, id))} /></div>}
  </section>;
}

function ConversationPane({ online, messages, draft, onDraft, onSubmit, busy, placeholder }: { online: number; messages: CollabRoomState["messages"]; draft: string; onDraft: (value: string) => void; onSubmit: (event: FormEvent) => void; busy: boolean; placeholder: string }) {
  const threadRef = useRef<HTMLDivElement>(null);
  useChatAutoScroll(threadRef, messages.at(-1)?.id);
  return <main className="desktop-collab-conversation group"><header><strong># group chat</strong><span>{online} online</span></header><div className="desktop-collab-thread" ref={threadRef}>{messages.map((message) => <article key={message.id} className={message.authorId === "local-host" ? "host" : "agent"}><header><b style={agentNameStyle(message.authorId)}>{message.authorName}</b><time>{formatTimestamp(message.createdAt)}</time></header><p>{message.body}</p></article>)}{!messages.length && <p className="empty">Start the group conversation.</p>}</div><form onSubmit={onSubmit}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder={placeholder} required /><button disabled={busy}>Send</button></form></main>;
}

function DirectPane({ worker, active, messages, draft, onDraft, onSubmit, onActivate, onPublish, onClose, onStart, busy }: { worker: CollabWorker; active: boolean; messages: CollabRoomState["messages"]; draft: string; onDraft: (value: string) => void; onSubmit: (event: FormEvent) => void; onActivate: () => void; onPublish: (message: CollabRoomState["messages"][number]) => void; onClose: () => void; onStart: () => void; busy: boolean }) {
  const threadRef = useRef<HTMLElement>(null);
  useChatAutoScroll(threadRef, messages.at(-1)?.id);
  return <aside className={`desktop-collab-direct${active ? " active" : ""}`} onMouseDown={onActivate}><header><div><i className={`runtime ${worker.runtimeStatus}`} /><strong style={agentNameStyle(worker.id)}>{worker.name}</strong><span>{worker.provider} / private</span></div><button type="button" onClick={(event) => { event.stopPropagation(); onClose(); }} aria-label={`Close ${worker.name} chat`}>x</button></header>{worker.runtimeStatus !== "running" && supportsRuntime(worker) && <button className="start-agent" type="button" onClick={onStart} disabled={busy || worker.runtimeStatus === "starting"}>Start agent</button>}<section className="desktop-collab-private-thread" ref={threadRef}><header>Private chat</header>{messages.map((message) => <article key={message.id} className={message.authorId === "local-host" ? "host" : "agent"}><header><b style={agentNameStyle(message.authorId)}>{message.authorName}</b><time>{formatTimestamp(message.createdAt)}</time>{message.authorId === worker.id && <button type="button" onClick={() => onPublish(message)}>Publish to group</button>}</header><p>{message.body}</p></article>)}{!messages.length && <p className="empty">Messages here stay between you and {worker.name}.</p>}</section><form onSubmit={onSubmit}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder={`Message ${worker.name} privately...`} required /><button disabled={busy || (supportsRuntime(worker) && worker.runtimeStatus !== "running")}>Send</button></form></aside>;
}

function AgentRoster({ workers, workerName, setWorkerName, provider, setProvider, model, setModel, effort, setEffort, modelOptions, effortOptions, modelsLoading, onAddWorker, onSelect, onStart, busy }: { workers: CollabWorker[]; workerName: string; setWorkerName: (value: string) => void; provider: string; setProvider: (value: string) => void; model: string; setModel: (value: string) => void; effort: string; setEffort: (value: string) => void; modelOptions: readonly ModelOption[]; effortOptions: readonly EffortOption[]; modelsLoading: boolean; onAddWorker: (event: FormEvent) => void; onSelect: (workerId: string) => void; onStart: (worker: CollabWorker) => void; busy: boolean }) {
  const configurable = provider === "codex" || provider === "claude";
  return <section className="desktop-collab-roster desktop-collab-restored-roster"><header><strong>People & agents</strong><span>{workers.length} total</span></header><div className="desktop-collab-worker-list">{workers.map((worker) => <article key={worker.id} role="button" tabIndex={0} onClick={() => onSelect(worker.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(worker.id); }}><header><b>{worker.name}</b><i className={`runtime ${worker.runtimeStatus}`}>{runtimeLabel(worker)}</i></header><span>{worker.provider}{worker.model ? ` / ${worker.model}` : ""}{worker.effort && worker.effort !== "default" ? ` / ${worker.effort}` : ""}</span><code>{worker.branch}</code>{worker.runtimeError && <p>{worker.runtimeError}</p>}<footer><button type="button" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(worker.worktreePath); }}>Copy path</button>{supportsRuntime(worker) && worker.runtimeStatus !== "running" && <button type="button" disabled={busy || worker.runtimeStatus === "starting"} onClick={(event) => { event.stopPropagation(); onStart(worker); }}>Start agent</button>}</footer></article>)}{!workers.length && <p className="desktop-collab-empty">Create an agent to add its isolated worktree.</p>}</div><form className="desktop-collab-form compact" onSubmit={onAddWorker}><label>Name<input value={workerName} onChange={(event) => setWorkerName(event.target.value)} placeholder="Frontend agent" required /></label><label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="opencode">OpenCode</option><option value="openrouter">OpenRouter</option><option value="human">Human collaborator</option></select></label>{configurable && <><label>Model<select value={model} onChange={(event) => setModel(event.target.value)} disabled={modelsLoading}>{modelsLoading && !modelOptions.length ? <option>Loading models...</option> : modelOptions.map(([id, description]) => <option key={id || "default"} value={id} title={description}>{id || "default"}</option>)}</select></label><label>Effort<select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={modelsLoading}>{effortOptions.map(([id, description]) => <option key={id} value={id} title={description}>{id}</option>)}</select></label></>}<button disabled={busy || (configurable && (!model || modelsLoading))}>Create isolated worker</button></form></section>;
}

function CoordinationDrawer(props: CoordinationProps) {
  const { state, busy } = props;
  const reviews = state.changeSets.filter((change) => change.status === "review");
  const approved = state.changeSets.filter((change) => change.status === "approved");
  return <aside className="desktop-collab-coordination" role="dialog" aria-modal="true" aria-label="Coordination"><header className="desktop-collab-coordination-header"><div><strong>Coordination</strong><span>Claims, locks, review, and integration</span></div><button type="button" onClick={props.onClose} aria-label="Close coordination">x</button></header><div className="desktop-collab-coordination-body"><section><header>Claims</header><form onSubmit={props.onCreateTask}><input value={props.taskTitle} onChange={(event) => props.setTaskTitle(event.target.value)} placeholder="Task" required /><input value={props.taskScope} onChange={(event) => props.setTaskScope(event.target.value)} placeholder="Scope: desktop/src/**" required /><button disabled={busy}>Create</button></form>{state.tasks.map((task) => <article key={task.id}><b>{task.title}</b><code>{task.scope}</code><select value={task.claimedBy || ""} onChange={(event) => props.onClaimTask(task.id, event.target.value || null)}><option value="">Unclaimed</option>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></article>)}</section><section><header>Leases</header><form onSubmit={props.onAcquireLease}><select value={props.leaseWorker} onChange={(event) => props.setLeaseWorker(event.target.value)} required><option value="">Worker</option>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select><input value={props.leaseResource} onChange={(event) => props.setLeaseResource(event.target.value)} placeholder="File or directory" required /><button disabled={busy}>Lock</button></form>{state.leases.map((lease) => <article key={lease.id}><code>{lease.resource}</code><span>{props.workerNames.get(lease.holderId)} / fence {lease.fencingToken}</span><button onClick={() => props.onRenewLease(lease)}>Renew</button><button onClick={() => props.onReleaseLease(lease)}>Release</button></article>)}</section><section><header>Review & integrate</header><form onSubmit={props.onSubmitChange}><select value={props.leaseWorker} onChange={(event) => props.setLeaseWorker(event.target.value)} required><option value="">Worker</option>{state.workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select><input value={props.submissionTitle} onChange={(event) => props.setSubmissionTitle(event.target.value)} placeholder="Change title" required /><input value={props.submissionSummary} onChange={(event) => props.setSubmissionSummary(event.target.value)} placeholder="Summary" /><button disabled={busy}>Submit</button></form>{reviews.map((change) => <article key={change.id}><b>{change.title}</b><span>{props.workerNames.get(change.workerId)}</span><button onClick={() => props.onReview(change.id, "approved")}>Approve</button><button onClick={() => props.onReview(change.id, "rejected")}>Reject</button></article>)}{approved.map((change, index) => <article key={change.id}><b>{change.title}</b><span>queue #{index + 1}</span><button disabled={index !== 0} onClick={() => props.onIntegrate(change.id)}>Integrate</button></article>)}</section></div></aside>;
}

type CoordinationProps = {
  state: CollabRoomState; busy: boolean; workerNames: Map<string, string>; onClose: () => void; taskTitle: string; setTaskTitle: (value: string) => void; taskScope: string; setTaskScope: (value: string) => void; leaseWorker: string; setLeaseWorker: (value: string) => void; leaseResource: string; setLeaseResource: (value: string) => void; submissionTitle: string; setSubmissionTitle: (value: string) => void; submissionSummary: string; setSubmissionSummary: (value: string) => void; onCreateTask: (event: FormEvent) => void; onClaimTask: (taskId: string, workerId: string | null) => void; onAcquireLease: (event: FormEvent) => void; onRenewLease: (lease: CollabRoomState["leases"][number]) => void; onReleaseLease: (lease: CollabRoomState["leases"][number]) => void; onSubmitChange: (event: FormEvent) => void; onReview: (id: string, decision: "approved" | "rejected") => void; onIntegrate: (id: string) => void;
};

function supportsRuntime(worker: CollabWorker) { return worker.provider === "codex" || worker.provider === "claude"; }
function runtimeLabel(worker: CollabWorker) { return supportsRuntime(worker) ? worker.runtimeStatus : worker.provider === "human" ? "person" : "adapter needed"; }
function codexEfforts(model: Awaited<ReturnType<typeof listCodexModels>>[number] | undefined): readonly EffortOption[] {
  if (!model) return [["default", "Use the model default"]];
  return [
    ["default", `Use ${model.defaultReasoningEffort || "the model"} default`],
    ...(model.supportedReasoningEfforts || []).map((option): EffortOption => [option.reasoningEffort, option.description]),
  ];
}
function useChatAutoScroll(threadRef: React.RefObject<HTMLElement>, lastMessageId: string | undefined) {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [lastMessageId, threadRef]);
}
function agentNameStyle(authorId: string): CSSProperties | undefined {
  if (authorId === "local-host") return undefined;
  const colors = ["#4ec9b0", "#dcdcaa", "#c586c0", "#ce9178", "#9cdcfe", "#b5cea8", "#d7a7ff", "#f2c97d"];
  let hash = 0;
  for (const character of authorId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { color: colors[hash % colors.length] };
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatTimestamp(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function codexAgentText(item: unknown) { if (typeof item !== "object" || item === null) return ""; const record = item as Record<string, unknown>; return record.type === "agentMessage" && typeof record.text === "string" ? record.text.trim() : ""; }
function codexToolText(item: unknown) { if (typeof item !== "object" || item === null) return ""; const record = item as Record<string, unknown>; return record.type === "commandExecution" && typeof record.command === "string" ? `$ ${record.command}` : record.type === "fileChange" ? "Changed files" : ""; }
function claudeAssistantText(message: Record<string, unknown>) { const assistant = message.message; if (typeof assistant !== "object" || assistant === null || !("content" in assistant)) return ""; const content = (assistant as { content?: unknown }).content; return Array.isArray(content) ? content.flatMap((block) => typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n").trim() : ""; }
async function markWorkerDisconnected(roomRef: string, worker: CollabWorker, updateState: (state: CollabRoomState) => void, setError: (error: string) => void) { try { updateState(await updateCollabWorkerRuntime(roomRef, worker.id, worker.sessionKey, worker.threadId, "offline", "Agent disconnected.")); } catch (error) { setError(errorText(error)); } }
