import type {
  DecodedInteractiveAgentRequest,
  InteractiveAgentRequest,
  InteractiveAgentResponse,
  InteractiveApprovalRequest,
  InteractiveUserInputQuestion,
} from "./interactive-agent-requests";

type ClaudeProviderData = {
  input: Record<string, unknown>;
  permissionSuggestions: unknown[];
};

export function decodeClaudeServerRequest(
  message: Record<string, unknown>,
): DecodedInteractiveAgentRequest | null {
  if (message.type !== "control_request") return null;
  const requestId = stringValue(message.request_id);
  const request = asRecord(message.request);
  const subtype = stringValue(request?.subtype);
  if (!requestId || !request) return null;
  if (subtype !== "can_use_tool") {
    return {
      type: "unsupported",
      requestId,
      method: `control_request/${subtype || "unknown"}`,
      description: `Claude sent an unsupported control request: ${subtype || "unknown"}.`,
    };
  }

  const toolName = stringValue(request.tool_name) || "Tool";
  const input = asRecord(request.input) || {};
  const permissionSuggestions = Array.isArray(request.permission_suggestions)
    ? request.permission_suggestions
    : [];
  const providerData: ClaudeProviderData = { input, permissionSuggestions };
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(input.questions)
      ? input.questions.map(decodeClaudeQuestion).filter((question) => question !== null)
      : [];
    return {
      type: "user_input",
      requestId,
      method: "canUseTool/AskUserQuestion",
      questions,
      providerData,
    };
  }

  const kind = claudeApprovalKind(toolName);
  const details = claudeApprovalDetails(toolName, input);
  return {
    type: "approval",
    requestId,
    method: `canUseTool/${toolName}`,
    kind,
    reason: stringValue(request.decision_reason)
      || stringValue(request.description)
      || `Claude wants to use ${stringValue(request.display_name) || toolName}.`,
    details,
    decisions: permissionSuggestions.length
      ? ["accept", "acceptForSession", "decline", "cancel"]
      : ["accept", "decline", "cancel"],
    permissions: permissionSuggestions,
    providerData,
    command: kind === "command" ? details : undefined,
    legacy: false,
  };
}

export function claudeServerRequestResult(
  request: InteractiveAgentRequest,
  response: InteractiveAgentResponse,
): Record<string, unknown> {
  if (request.type !== response.type) {
    throw new Error("Interactive response does not match the active Claude request.");
  }
  if (request.type === "mcp_elicitation") {
    throw new Error("Claude does not support this interactive request type.");
  }
  const providerData = decodeProviderData(request.providerData);
  if (!providerData) throw new Error("Claude request transport data is unavailable.");

  if (request.type === "user_input" && response.type === "user_input") {
    const answers = cleanAnswers(response.answers);
    if (!Object.keys(answers).length) {
      return { behavior: "deny", message: "User declined to answer the question." };
    }
    return {
      behavior: "allow",
      updatedInput: { ...providerData.input, answers },
    };
  }
  if (request.type === "approval" && response.type === "approval") {
    const decision = typeof response.decision === "string" ? response.decision : "accept";
    if (decision === "decline" || decision === "denied") {
      return { behavior: "deny", message: "User declined this tool request." };
    }
    if (decision === "cancel" || decision === "abort") {
      return { behavior: "deny", message: "User cancelled the turn.", interrupt: true };
    }
    return {
      behavior: "allow",
      updatedInput: providerData.input,
      ...(decision === "acceptForSession" && providerData.permissionSuggestions.length
        ? { updatedPermissions: providerData.permissionSuggestions }
        : {}),
    };
  }
  throw new Error("Claude does not support this interactive request type.");
}

export function isClaudeServerRequestResolved(message: Record<string, unknown>): boolean {
  return message.type === "control_cancel_request";
}

function decodeClaudeQuestion(value: unknown, index: number): InteractiveUserInputQuestion | null {
  const question = asRecord(value);
  if (!question) return null;
  const prompt = stringValue(question.question);
  if (!prompt) return null;
  const options = Array.isArray(question.options)
    ? question.options.flatMap((value) => {
      const option = asRecord(value);
      const label = stringValue(option?.label);
      return label ? [{ label, description: stringValue(option?.description) }] : [];
    })
    : [];
  return {
    // Claude's SDK maps answers by the full question text.
    id: prompt,
    header: stringValue(question.header) || `Question ${index + 1}`,
    question: prompt,
    options,
    isOther: true,
    isSecret: false,
    multiSelect: question.multiSelect === true,
  };
}

function claudeApprovalKind(toolName: string): InteractiveApprovalRequest["kind"] {
  if (toolName === "Bash" || toolName === "Shell") return "command";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"].includes(toolName)) return "file";
  return "permissions";
}

function claudeApprovalDetails(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "Shell") return stringValue(input.command);
  for (const key of ["file_path", "path", "notebook_path", "url", "query"]) {
    const detail = stringValue(input[key]);
    if (detail) return detail;
  }
  return safeJson(input);
}

function decodeProviderData(value: unknown): ClaudeProviderData | null {
  const data = asRecord(value);
  const input = asRecord(data?.input);
  if (!input) return null;
  return {
    input,
    permissionSuggestions: Array.isArray(data?.permissionSuggestions)
      ? data.permissionSuggestions
      : [],
  };
}

function cleanAnswers(answers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).flatMap(([question, value]) => {
    const answer = value.trim();
    return answer ? [[question, answer]] : [];
  }));
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
    return "Requested tool access";
  }
}
