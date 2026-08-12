import { describe, expect, it } from "vitest";
import { codexApprovalResult, decodeCodexServerRequest } from "./codex-server-requests";

describe("Codex server request dispatch", () => {
  it("decodes modern command approvals", () => {
    expect(decodeCodexServerRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "cargo check", reason: "Network access" },
    })).toMatchObject({
      type: "approval",
      id: 7,
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

  it("classifies unimplemented requests instead of silently ignoring them", () => {
    expect(decodeCodexServerRequest({
      id: 12,
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    })).toEqual({
      type: "unsupported",
      id: 12,
      method: "item/tool/requestUserInput",
      description: "Codex requested structured user input.",
    });
  });

  it("ignores notifications and responses", () => {
    expect(decodeCodexServerRequest({ method: "turn/started", params: {} })).toBeNull();
    expect(decodeCodexServerRequest({ id: 3, result: {} })).toBeNull();
  });
});
