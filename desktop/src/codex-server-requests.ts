export type CodexApprovalDecision = string | Record<string, unknown>;

export type CodexApprovalRequest = {
  type: "approval";
  id: unknown;
  method: string;
  kind: "command" | "file" | "permissions";
  reason: string;
  details: string;
  decisions: CodexApprovalDecision[];
  permissions?: unknown;
  command?: string;
  legacy: boolean;
};

export type CodexUnsupportedRequest = {
  type: "unsupported";
  id: unknown;
  method: string;
  description: string;
};

export type CodexServerRequest = CodexApprovalRequest | CodexUnsupportedRequest;

const MODERN_DECISIONS: CodexApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];

const LEGACY_DECISIONS: CodexApprovalDecision[] = [
  "approved",
  "approved_for_session",
  "denied",
  "abort",
];

export function decodeCodexServerRequest(message: Record<string, unknown>): CodexServerRequest | null {
  const method = typeof message.method === "string" ? message.method : null;
  if (!method || message.id === undefined) return null;
  const params = asRecord(message.params) || {};
  const reason = stringValue(params.reason) || "Codex needs permission to continue.";

  if (method === "item/commandExecution/requestApproval") {
    const command = stringValue(params.command);
    return approval(message.id, method, "command", reason, command, params, false);
  }
  if (method === "item/fileChange/requestApproval" || method === "item/fileRead/requestApproval") {
    const details = stringValue(params.grantRoot) || stringValue(params.path);
    return approval(message.id, method, "file", reason, details, params, false);
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = params.permissions;
    const details = permissions === undefined ? "" : safeJson(permissions);
    return {
      ...approval(message.id, method, "permissions", reason, details, params, false),
      permissions,
      decisions: decisionList(params.availableDecisions, ["accept", "decline"]),
    };
  }
  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command)
      ? params.command.filter((value): value is string => typeof value === "string").join(" ")
      : stringValue(params.command);
    return approval(message.id, method, "command", reason, command, params, true);
  }
  if (method === "applyPatchApproval") {
    const details = stringValue(params.grantRoot) || fileChangeSummary(params.fileChanges);
    return approval(message.id, method, "file", reason, details, params, true);
  }

  return {
    type: "unsupported",
    id: message.id,
    method,
    description: unsupportedRequestDescription(method),
  };
}

export function codexApprovalResult(
  request: CodexApprovalRequest,
  decision: CodexApprovalDecision,
): Record<string, unknown> {
  if (request.kind === "permissions") {
    return decision === "accept"
      ? { permissions: request.permissions, scope: "turn" }
      : { permissions: {} };
  }
  return { decision };
}

function approval(
  id: unknown,
  method: string,
  kind: CodexApprovalRequest["kind"],
  reason: string,
  details: string,
  params: Record<string, unknown>,
  legacy: boolean,
): CodexApprovalRequest {
  const command = kind === "command" ? details || undefined : undefined;
  return {
    type: "approval",
    id,
    method,
    kind,
    reason,
    details,
    command,
    legacy,
    decisions: decisionList(
      params.availableDecisions,
      legacy ? LEGACY_DECISIONS : MODERN_DECISIONS,
    ),
  };
}

function decisionList(value: unknown, fallback: CodexApprovalDecision[]): CodexApprovalDecision[] {
  if (!Array.isArray(value)) return fallback;
  const decisions = value.filter((decision): decision is CodexApprovalDecision =>
    typeof decision === "string" || (typeof decision === "object" && decision !== null),
  );
  return decisions.length ? decisions : fallback;
}

function fileChangeSummary(value: unknown): string {
  const changes = asRecord(value);
  if (!changes) return "";
  const paths = Object.keys(changes);
  if (!paths.length) return "";
  return paths.length === 1 ? paths[0] : `${paths.length} files`;
}

function unsupportedRequestDescription(method: string): string {
  if (method === "item/tool/requestUserInput") return "Codex requested structured user input.";
  if (method === "mcpServer/elicitation/request") return "An MCP server requested additional input.";
  if (method === "item/tool/call") return "Codex requested a dynamic client tool.";
  if (method === "account/chatgptAuthTokens/refresh") return "Codex requested refreshed authentication tokens.";
  if (method === "attestation/generate") return "Codex requested client attestation.";
  return `Codex sent an unsupported request: ${method}.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "Requested permissions";
  }
}
