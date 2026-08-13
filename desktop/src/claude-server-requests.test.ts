import { describe, expect, it } from "vitest";
import {
  claudeServerRequestResult,
  decodeClaudeServerRequest,
  isClaudeServerRequestResolved,
} from "./claude-server-requests";

describe("Claude interactive request bridge", () => {
  it("translates AskUserQuestion control requests into shared user input", () => {
    const request = decodeClaudeServerRequest({
      type: "control_request",
      request_id: "claude-question-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [{
            header: "Scope",
            question: "Which packages should change?",
            multiSelect: true,
            options: [
              { label: "Desktop", description: "Tauri application" },
              { label: "Web", description: "Browser application" },
            ],
          }],
        },
      },
    });
    expect(request).toMatchObject({
      type: "user_input",
      requestId: "claude-question-1",
      questions: [{
        id: "Which packages should change?",
        header: "Scope",
        multiSelect: true,
        isOther: true,
      }],
    });
    if (request?.type !== "user_input") return;
    expect(claudeServerRequestResult(request, {
      type: "user_input",
      answers: { "Which packages should change?": "Desktop, Web" },
    })).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [{
          header: "Scope",
          question: "Which packages should change?",
          multiSelect: true,
          options: [
            { label: "Desktop", description: "Tauri application" },
            { label: "Web", description: "Browser application" },
          ],
        }],
        answers: { "Which packages should change?": "Desktop, Web" },
      },
    });
  });

  it("translates tool permissions and preserves session suggestions", () => {
    const request = decodeClaudeServerRequest({
      type: "control_request",
      request_id: "claude-tool-2",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "cargo check" },
        permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
      },
    });
    expect(request).toMatchObject({
      type: "approval",
      kind: "command",
      command: "cargo check",
      decisions: ["accept", "acceptForSession", "decline", "cancel"],
    });
    if (request?.type !== "approval") return;
    expect(claudeServerRequestResult(request, { type: "approval", decision: "acceptForSession" }))
      .toEqual({
        behavior: "allow",
        updatedInput: { command: "cargo check" },
        updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
      });
    expect(claudeServerRequestResult(request, { type: "approval", decision: "cancel" }))
      .toEqual({ behavior: "deny", message: "User cancelled the turn.", interrupt: true });
  });

  it("recognizes cancellation and rejects unknown control requests", () => {
    expect(isClaudeServerRequestResolved({ type: "control_cancel_request", request_id: "r-1" })).toBe(true);
    expect(decodeClaudeServerRequest({
      type: "control_request",
      request_id: "r-2",
      request: { subtype: "future_request" },
    })).toMatchObject({ type: "unsupported", method: "control_request/future_request" });
  });
});
