import type {
  InteractiveApprovalDecision,
  InteractiveApprovalRequest,
} from "./interactive-agent-requests";

export type NotificationApprovalAction = "allow" | "decline";

const ALLOW_DECISIONS = ["accept", "approved"];
const DECLINE_DECISIONS = ["decline", "denied", "cancel", "abort"];

export function notificationApprovalDecision(
  request: InteractiveApprovalRequest,
  action: NotificationApprovalAction,
): InteractiveApprovalDecision | null {
  const preferred = action === "allow" ? ALLOW_DECISIONS : DECLINE_DECISIONS;
  for (const name of preferred) {
    const decision = request.decisions.find((candidate) => candidate === name);
    if (decision !== undefined) return decision;
  }
  return null;
}
