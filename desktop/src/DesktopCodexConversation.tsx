import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { connectCodexThread, respondToCodexApproval, sendCodexTurn } from "./desktop-api";

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

type ConnectionState = "idle" | "connecting" | "ready" | "error";

type ImageAttachment = { id: string; url: string; name: string };
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export default function DesktopCodexConversation({ sessionKey, threadId, cwd, onApprovalChange }: {
  sessionKey: string;
  threadId: string;
  cwd: string;
  onApprovalChange?: (command: string | null) => void;
}) {
  const [state, setState] = useState<ConnectionState>("idle");
  const [draft, setDraft] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);

  useEffect(() => {
    if (!draft) composerRef.current?.style.removeProperty("height");
  }, [activeTurnId, draft]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
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
  }, [onApprovalChange, sessionKey]);

  async function connect(): Promise<boolean> {
    if (state === "connecting") return false;
    setState("connecting");
    setError("");
    try {
      await connectCodexThread(sessionKey, threadId, cwd);
      setState("ready");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
      return false;
    }
  }

  async function submit() {
    const text = draft.trim();
    if ((!text && !images.length) || sending) return;
    setSending(true);
    if (state !== "ready" && !(await connect())) {
      setSending(false);
      return;
    }
    try {
      await sendCodexTurn(sessionKey, threadId, text, images.map((image) => image.url));
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

  return (
    <section className="desktop-codex-live-strip" aria-label="Message Codex">
      <div className={`desktop-codex-live-bar${images.length ? " has-images" : ""}`}>
        <span
          className={`desktop-codex-live-dot ${approval ? "running" : activeTurnId ? "paused" : state}`}
          aria-label={approval ? "Codex needs approval" : activeTurnId ? "Codex working" : "Codex ready"}
          role="status"
        />
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={activeTurnId ? "Steer Codex..." : "Message Codex..."}
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
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
