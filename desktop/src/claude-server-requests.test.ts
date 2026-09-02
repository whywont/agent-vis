import { describe, expect, it } from "vitest";
import {
  claudeElicitationCompletionResponse,
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

  it("translates Claude MCP form and URL elicitations", () => {
    const request = decodeClaudeServerRequest({
      type: "control_request",
      request_id: "claude-elicitation-1",
      request: {
        subtype: "elicitation",
        mcp_server_name: "deploy-tools",
        message: "Choose a deployment region",
        mode: "form",
        requested_schema: {
          type: "object",
          required: ["region"],
          properties: {
            region: { type: "string", enum: ["us-east-1", "us-west-2"] },
          },
        },
      },
    });
    expect(request).toMatchObject({
      type: "mcp_elicitation",
      requestId: "claude-elicitation-1",
      method: "control_request/elicitation",
      serverName: "deploy-tools",
      mode: "form",
      canAccept: true,
      fields: [{ id: "region", kind: "single_select", required: true }],
    });
    if (request?.type !== "mcp_elicitation") return;
    expect(claudeServerRequestResult(request, {
      type: "mcp_elicitation",
      action: "accept",
      content: { region: "us-west-2" },
    })).toEqual({ action: "accept", content: { region: "us-west-2" } });
    expect(claudeServerRequestResult(request, {
      type: "mcp_elicitation",
      action: "decline",
      content: {},
    })).toEqual({ action: "decline" });

    expect(decodeClaudeServerRequest({
      type: "control_request",
      request_id: "claude-elicitation-url",
      request: {
        subtype: "elicitation",
        mcp_server_name: "identity-provider",
        message: "Sign in",
        mode: "url",
        url: "https://example.com/authorize",
        elicitation_id: "auth-1",
      },
    })).toMatchObject({
      type: "mcp_elicitation",
      mode: "url",
      url: "https://example.com/authorize",
      elicitationId: "auth-1",
      canAccept: true,
    });
  });

  it("recognizes cancellation and rejects unknown control requests", () => {
    const urlRequest = decodeClaudeServerRequest({
      type: "control_request",
      request_id: "r-1",
      request: {
        subtype: "elicitation",
        mode: "url",
        url: "https://example.com/authorize",
        elicitation_id: "auth-1",
      },
    });
    expect(urlRequest?.type).toBe("mcp_elicitation");
    if (!urlRequest || urlRequest.type === "unsupported") return;
    expect(isClaudeServerRequestResolved({ type: "control_cancel_request", request_id: "r-1" }, urlRequest)).toBe(true);
    expect(isClaudeServerRequestResolved({ type: "agent-vis/server-request-resolved", request_id: "r-1" }, urlRequest)).toBe(true);
    const completion = {
      type: "system",
      subtype: "elicitation_complete",
      elicitation_id: "auth-1",
    };
    expect(isClaudeServerRequestResolved(completion, urlRequest)).toBe(true);
    expect(claudeElicitationCompletionResponse(completion, urlRequest)).toEqual({
      type: "mcp_elicitation",
      action: "accept",
      content: {},
    });
    expect(isClaudeServerRequestResolved({ ...completion, elicitation_id: "other" }, urlRequest)).toBe(false);
    expect(decodeClaudeServerRequest({
      type: "control_request",
      request_id: "r-2",
      request: { subtype: "future_request" },
    })).toMatchObject({ type: "unsupported", method: "control_request/future_request" });
  });
});
