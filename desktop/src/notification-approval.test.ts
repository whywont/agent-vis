import { describe, expect, it } from "vitest";
import type { InteractiveApprovalRequest } from "./interactive-agent-requests";
import { notificationApprovalDecision } from "./notification-approval";

function request(decisions: string[], legacy = false): InteractiveApprovalRequest {
  return {
    type: "approval",
    requestId: "request-1",
    method: "item/commandExecution/requestApproval",
    kind: "command",
    reason: "Run tests",
    details: "pnpm test",
    decisions,
    legacy,
  };
}

describe("notification approval decisions", () => {
  it("uses one-turn modern decisions instead of session-wide approval", () => {
    const approval = request(["acceptForSession", "accept", "decline", "cancel"]);
    expect(notificationApprovalDecision(approval, "allow")).toBe("accept");
    expect(notificationApprovalDecision(approval, "decline")).toBe("decline");
  });

  it("maps legacy approval names", () => {
    const approval = request(["approved_for_session", "approved", "denied", "abort"], true);
    expect(notificationApprovalDecision(approval, "allow")).toBe("approved");
    expect(notificationApprovalDecision(approval, "decline")).toBe("denied");
  });

  it("does not invent a decision the server did not offer", () => {
    expect(notificationApprovalDecision(request(["acceptForSession"]), "allow")).toBeNull();
  });
});
