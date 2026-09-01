import { describe, expect, it } from "vitest";
import type { InteractiveAgentRequest } from "./interactive-agent-requests";
import { enqueueInteractiveRequest, removeInteractiveRequest } from "./interactive-request-queue";

function approval(requestId: number): InteractiveAgentRequest {
  return {
    type: "approval",
    requestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    reason: "Needs permission",
    details: `command ${requestId}`,
    decisions: ["accept", "decline"],
    legacy: false,
  };
}

describe("interactive request queue", () => {
  it("preserves parallel requests in arrival order", () => {
    const first = approval(1);
    const second = approval(2);
    expect(enqueueInteractiveRequest(enqueueInteractiveRequest([], first), second)).toEqual([first, second]);
  });

  it("deduplicates replayed requests and advances after a response", () => {
    const first = approval(1);
    const second = approval(2);
    const queue = enqueueInteractiveRequest(enqueueInteractiveRequest([first], first), second);
    expect(removeInteractiveRequest(queue, first)).toEqual([second]);
  });
});
