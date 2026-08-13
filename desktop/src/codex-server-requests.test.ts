import { describe, expect, it } from "vitest";
import {
  codexApprovalResult,
  codexMcpElicitationResult,
  codexServerRequestResult,
  codexUserInputResult,
  decodeCodexServerRequest,
} from "./codex-server-requests";
import { mcpElicitationDefaults } from "./interactive-agent-requests";

describe("Codex server request dispatch", () => {
  it("decodes modern command approvals", () => {
    expect(decodeCodexServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "cargo check", reason: "Network access" },
    })).toMatchObject({
      type: "approval",
      requestId: 7,
      kind: "command",
      command: "cargo check",
      legacy: false,
      decisions: ["accept", "acceptForSession", "decline", "cancel"],
    });
  });

  it("uses legacy decision values for legacy command approvals", () => {
    expect(decodeCodexServerRequest({
      id: "approval-1",
      method: "execCommandApproval",
      params: { command: ["cargo", "check"] },
    })).toMatchObject({
      type: "approval",
      command: "cargo check",
      legacy: true,
      decisions: ["approved", "approved_for_session", "denied", "abort"],
    });
  });

  it("summarizes legacy patch requests", () => {
    expect(decodeCodexServerRequest({
      id: 9,
      method: "applyPatchApproval",
      params: { fileChanges: { "src/a.ts": {}, "src/b.ts": {} } },
    })).toMatchObject({ type: "approval", kind: "file", details: "2 files", legacy: true });
  });

  it("builds permission responses separately from decision responses", () => {
    const request = decodeCodexServerRequest({
      id: 11,
      method: "item/permissions/requestApproval",
      params: { permissions: { network: { enabled: true } } },
    });
    expect(request?.type).toBe("approval");
    if (request?.type !== "approval") return;
    expect(codexApprovalResult(request, "accept")).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
    expect(codexApprovalResult(request, "decline")).toEqual({ permissions: {} });
  });

  it("decodes structured user input and builds the app-server response", () => {
    expect(decodeCodexServerRequest({
      id: 12,
      method: "item/tool/requestUserInput",
      params: {
        autoResolutionMs: 30000,
        questions: [{
          id: "scope",
          header: "Scope",
          question: "Which files?",
          options: [{ label: "Changed", description: "Only changed files" }],
          isOther: true,
          isSecret: false,
        }],
      },
    })).toMatchObject({
      type: "user_input",
      requestId: 12,
      method: "item/tool/requestUserInput",
      autoResolutionMs: 30000,
      questions: [{
        id: "scope",
        options: [{ label: "Changed", description: "Only changed files" }],
        isOther: true,
      }],
    });
    expect(codexUserInputResult({ scope: " Changed ", empty: "  " })).toEqual({
      answers: { scope: { answers: ["Changed"] } },
    });
  });

  it("classifies other unimplemented requests instead of silently ignoring them", () => {
    expect(decodeCodexServerRequest({ id: 13, method: "item/tool/call", params: {} }))
      .toMatchObject({ type: "unsupported", method: "item/tool/call" });
  });

  it("decodes standard MCP form elicitations and builds typed responses", () => {
    const request = decodeCodexServerRequest({
      id: "mcp-1",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        serverName: "deploy-tools",
        message: "Choose deployment settings",
        requestedSchema: {
          type: "object",
          required: ["environment", "replicas"],
          properties: {
            environment: {
              type: "string",
              title: "Environment",
              oneOf: [{ const: "staging", title: "Staging" }, { const: "prod", title: "Production" }],
              default: "staging",
            },
            replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 10, default: 2 },
            notify: { type: "boolean", title: "Notify team", default: true },
            reviewers: {
              type: "array",
              title: "Reviewers",
              items: { type: "string", enum: ["api", "web"] },
              default: ["api"],
            },
          },
        },
      },
    });
    expect(request).toMatchObject({
      type: "mcp_elicitation",
      mode: "form",
      serverName: "deploy-tools",
      canAccept: true,
      fields: [
        { id: "environment", kind: "single_select", required: true, defaultValue: "staging" },
        { id: "replicas", kind: "integer", required: true, minimum: 1, maximum: 10, defaultValue: 2 },
        { id: "notify", kind: "boolean", defaultValue: true },
        { id: "reviewers", kind: "multi_select", defaultValue: ["api"] },
      ],
    });
    if (request?.type !== "mcp_elicitation") return;
    expect(mcpElicitationDefaults(request)).toEqual({
      environment: "staging",
      replicas: 2,
      notify: true,
      reviewers: ["api"],
    });
    expect(codexMcpElicitationResult("accept", { environment: "prod", replicas: 3 })).toEqual({
      action: "accept",
      content: { environment: "prod", replicas: 3 },
    });
    expect(codexMcpElicitationResult("decline")).toEqual({ action: "decline" });
    expect(codexServerRequestResult(request, {
      type: "mcp_elicitation",
      action: "accept",
      content: { environment: "prod" },
    })).toEqual({ action: "accept", content: { environment: "prod" } });
    expect(() => codexServerRequestResult(request, { type: "user_input", answers: {} }))
      .toThrow("does not match");
  });

  it("only accepts safe MCP URL requests and leaves extended forms rejectable", () => {
    expect(decodeCodexServerRequest({
      id: "mcp-url",
      method: "mcpServer/elicitation/request",
      params: { mode: "url", url: "https://example.com/authorize", serverName: "github", message: "Sign in" },
    })).toMatchObject({ type: "mcp_elicitation", mode: "url", canAccept: true, url: "https://example.com/authorize" });
    expect(decodeCodexServerRequest({
      id: "mcp-bad-url",
      method: "mcpServer/elicitation/request",
      params: { mode: "url", url: "javascript:alert(1)" },
    })).toMatchObject({ type: "mcp_elicitation", mode: "url", canAccept: false });
    expect(decodeCodexServerRequest({
      id: "mcp-openai",
      method: "mcpServer/elicitation/request",
      params: { mode: "openai/form", requestedSchema: {} },
    })).toMatchObject({ type: "mcp_elicitation", mode: "openai/form", canAccept: false });
  });

  it("ignores notifications and responses", () => {
    expect(decodeCodexServerRequest({ method: "turn/started", params: {} })).toBeNull();
    expect(decodeCodexServerRequest({ id: 3, result: {} })).toBeNull();
  });
});
