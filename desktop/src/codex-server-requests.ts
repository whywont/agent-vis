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

export type CodexUserInputOption = {
  label: string;
  description: string;
};

export type CodexUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: CodexUserInputOption[];
  isOther: boolean;
  isSecret: boolean;
};

export type CodexUserInputRequest = {
  type: "user_input";
  id: unknown;
  method: "item/tool/requestUserInput";
  questions: CodexUserInputQuestion[];
  autoResolutionMs?: number;
};

export type CodexUnsupportedRequest = {
  type: "unsupported";
  id: unknown;
  method: string;
  description: string;
};

export type CodexServerRequest = CodexApprovalRequest | CodexUserInputRequest | CodexUnsupportedRequest;

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

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions)
      ? params.questions.map(decodeUserInputQuestion).filter((question) => question !== null)
      : [];
    return {
      type: "user_input",
      id: message.id,
      method,
      questions,
      ...(typeof params.autoResolutionMs === "number" && params.autoResolutionMs >= 0
        ? { autoResolutionMs: params.autoResolutionMs }
        : {}),
    };
  }

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

export function codexUserInputResult(
  answers: Record<string, string>,
): { answers: Record<string, { answers: string[] }> } {
  const entries: Array<[string, { answers: string[] }]> = [];
  for (const [questionId, value] of Object.entries(answers)) {
    const answer = value.trim();
    if (answer) entries.push([questionId, { answers: [answer] }]);
  }
  return {
    answers: Object.fromEntries(entries),
  };
}

function decodeUserInputQuestion(value: unknown): CodexUserInputQuestion | null {
  const question = asRecord(value);
  if (!question) return null;
  const id = stringValue(question.id);
  const header = stringValue(question.header);
  const prompt = stringValue(question.question);
  if (!id || !header || !prompt) return null;
  const options = Array.isArray(question.options)
    ? question.options.map(decodeUserInputOption).filter((option) => option !== null)
    : [];
  return {
    id,
    header,
    question: prompt,
    options,
    isOther: question.isOther === true,
    isSecret: question.isSecret === true,
  };
}

function decodeUserInputOption(value: unknown): CodexUserInputOption | null {
  const option = asRecord(value);
  if (!option) return null;
  const label = stringValue(option.label);
  const description = stringValue(option.description);
  return label && description ? { label, description } : null;
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
