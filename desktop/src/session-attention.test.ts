import { describe, expect, it } from "vitest";
import type { AgentProviderRuntimeEvent } from "./desktop-api";
import { applyRuntimeAttentionEvent } from "./session-attention";

function runtime(message: unknown, sequence = 1): AgentProviderRuntimeEvent {
  return { providerInstanceId: "codex", sessionKey: "codex:thread-1", sequence, message };
}

describe("session attention", () => {
  it("adds and deduplicates an approval request", () => {
    const event = runtime({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test", reason: "Needs permission" },
    });
    const first = applyRuntimeAttentionEvent([], event);
    const replay = applyRuntimeAttentionEvent(first.attentions, event);

    expect(first.added?.request.type).toBe("approval");
    expect(replay.attentions).toHaveLength(1);
    expect(replay.added).toBeNull();
  });

  it("removes only the request acknowledged by Codex", () => {
    const first = applyRuntimeAttentionEvent([], runtime({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "one" },
    })).attentions;
    const second = applyRuntimeAttentionEvent(first, runtime({
      id: "approval-2",
      method: "item/commandExecution/requestApproval",
      params: { command: "two" },
    }, 2)).attentions;
    const resolved = applyRuntimeAttentionEvent(second, runtime({
      method: "serverRequest/resolved",
      params: { requestId: "approval-1" },
    }, 3));

    expect(resolved.attentions.map((attention) => attention.request.requestId)).toEqual(["approval-2"]);
  });

  it("clears outstanding attention when the turn completes", () => {
    const pending = applyRuntimeAttentionEvent([], runtime({
      id: 7,
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    })).attentions;

    expect(applyRuntimeAttentionEvent(pending, runtime({ method: "turn/completed", params: {} }, 2)).attentions).toEqual([]);
  });
});
