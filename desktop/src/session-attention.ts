import type { AgentProviderRuntimeEvent } from "./desktop-api";
import { getHarnessAdapter, type LiveProvider } from "./harness-adapters";
import type { InteractiveAgentRequest } from "./interactive-agent-requests";

export interface SessionAttention {
  key: string;
  provider: LiveProvider;
  sessionKey: string;
  request: InteractiveAgentRequest;
}

export function applyRuntimeAttentionEvent(
  current: readonly SessionAttention[],
  event: AgentProviderRuntimeEvent,
): { attentions: SessionAttention[]; added: SessionAttention | null } {
  if (event.providerInstanceId !== "codex" && event.providerInstanceId !== "claude-code") {
    return { attentions: [...current], added: null };
  }
  const provider = event.providerInstanceId;
  const message = recordValue(event.message);
  if (!message) return { attentions: [...current], added: null };
  const adapter = getHarnessAdapter(provider);
  const interactive = adapter.interactiveRequests;
  let attentions = shouldClearSessionAttention(provider, message)
    ? current.filter((attention) => !sameSession(attention, provider, event.sessionKey))
    : current.filter((attention) => {
      if (!sameSession(attention, provider, event.sessionKey)) return true;
      return !interactive?.isResolved?.(message, attention.request)
        && !interactive?.completionResponse?.(message, attention.request);
    });

  const request = interactive?.decode(message);
  if (!request || request.type === "unsupported") return { attentions, added: null };
  const key = `${provider}:${event.sessionKey}:${request.method}:${String(request.requestId)}`;
  if (attentions.some((attention) => attention.key === key)) return { attentions, added: null };
  const added: SessionAttention = { key, provider, sessionKey: event.sessionKey, request };
  attentions = [...attentions, added];
  return { attentions, added };
}

export function attentionDetail(attention: SessionAttention): string {
  if (attention.request.type === "approval") return attention.request.reason;
  if (attention.request.type === "mcp_elicitation") return attention.request.message;
  return "The agent is waiting for your response.";
}

function sameSession(attention: SessionAttention, provider: LiveProvider, sessionKey: string): boolean {
  return attention.provider === provider && attention.sessionKey === sessionKey;
}

function shouldClearSessionAttention(provider: LiveProvider, message: Record<string, unknown>): boolean {
  if (message.method === "agent-vis/disconnected" || message.type === "agent-vis/disconnected") return true;
  return provider === "codex" ? message.method === "turn/completed" : message.type === "result";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
