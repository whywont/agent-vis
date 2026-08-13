import type {
  DecodedInteractiveAgentRequest,
  InteractiveAgentRequest,
  InteractiveAgentResponse,
  InteractiveApprovalDecision,
  InteractiveApprovalRequest,
  InteractiveMcpElicitationField,
  InteractiveMcpElicitationOption,
  InteractiveMcpElicitationRequest,
  InteractiveMcpElicitationValue,
  InteractiveUserInputOption,
  InteractiveUserInputQuestion,
} from "./interactive-agent-requests";

export type CodexServerRequest = DecodedInteractiveAgentRequest;

const MODERN_DECISIONS: InteractiveApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];

const LEGACY_DECISIONS: InteractiveApprovalDecision[] = [
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
      requestId: message.id,
      method,
      questions,
      ...(typeof params.autoResolutionMs === "number" && params.autoResolutionMs >= 0
        ? { autoResolutionMs: params.autoResolutionMs }
        : {}),
    };
  }

  if (method === "mcpServer/elicitation/request") {
    return decodeMcpElicitation(message.id, params);
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
    requestId: message.id,
    method,
    description: unsupportedRequestDescription(method),
  };
}

export function codexApprovalResult(
  request: InteractiveApprovalRequest,
  decision: InteractiveApprovalDecision,
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

export function codexMcpElicitationResult(
  action: "accept" | "decline" | "cancel",
  content: Record<string, InteractiveMcpElicitationValue> = {},
): { action: "accept" | "decline" | "cancel"; content?: Record<string, InteractiveMcpElicitationValue> } {
  if (action !== "accept") return { action };
  return { action, content };
}

export function codexServerRequestResult(
  request: InteractiveAgentRequest,
  response: InteractiveAgentResponse,
): Record<string, unknown> {
  if (request.type !== response.type) throw new Error("Interactive response does not match the active Codex request.");
  if (request.type === "approval" && response.type === "approval") {
    return codexApprovalResult(request, response.decision);
  }
  if (request.type === "user_input" && response.type === "user_input") {
    return codexUserInputResult(response.answers);
  }
  if (request.type === "mcp_elicitation" && response.type === "mcp_elicitation") {
    return codexMcpElicitationResult(response.action, response.content);
  }
  throw new Error("Interactive response does not match the active Codex request.");
}

function decodeMcpElicitation(requestId: unknown, params: Record<string, unknown>): InteractiveMcpElicitationRequest {
  const rawMode = stringValue(params.mode);
  const mode: InteractiveMcpElicitationRequest["mode"] = rawMode === "form" || rawMode === "url" || rawMode === "openai/form"
    ? rawMode
    : "unknown";
  const base = {
    type: "mcp_elicitation" as const,
    requestId,
    method: "mcpServer/elicitation/request" as const,
    mode,
    serverName: stringValue(params.serverName) || "MCP server",
    message: stringValue(params.message) || "This MCP server needs additional input.",
    fields: [] as InteractiveMcpElicitationField[],
  };

  if (mode === "url") {
    const url = safeHttpUrl(params.url);
    return url
      ? { ...base, url, canAccept: true }
      : { ...base, canAccept: false, unsupportedReason: "The request URL is missing or is not an HTTP(S) URL." };
  }
  if (mode === "openai/form") {
    return {
      ...base,
      canAccept: false,
      unsupportedReason: "This server requested an extended OpenAI form that Agent Vis does not advertise yet.",
    };
  }
  if (mode !== "form") {
    return { ...base, canAccept: false, unsupportedReason: "This server used an unknown elicitation mode." };
  }

  const requestedSchema = asRecord(params.requestedSchema);
  const properties = asRecord(requestedSchema?.properties);
  const required = new Set(Array.isArray(requestedSchema?.required)
    ? requestedSchema.required.filter((value): value is string => typeof value === "string")
    : []);
  if (!requestedSchema || requestedSchema.type !== "object" || !properties) {
    return { ...base, canAccept: false, unsupportedReason: "The server sent an invalid form schema." };
  }
  const entries = Object.entries(properties);
  const fields = entries
    .map(([fieldId, schema]) => decodeMcpElicitationField(fieldId, schema, required.has(fieldId)))
    .filter((field) => field !== null);
  const fullySupported = fields.length === entries.length;
  return {
    ...base,
    fields,
    canAccept: fullySupported,
    ...(!fullySupported ? { unsupportedReason: "The form contains field types Agent Vis cannot render safely." } : {}),
  };
}

function decodeMcpElicitationField(
  id: string,
  value: unknown,
  required: boolean,
): InteractiveMcpElicitationField | null {
  const schema = asRecord(value);
  if (!schema || !id) return null;
  const type = stringValue(schema.type);
  const title = stringValue(schema.title) || id;
  const description = stringValue(schema.description);
  const base = { id, title, description, required };

  if (type === "boolean") {
    return {
      ...base,
      kind: "boolean",
      ...(typeof schema.default === "boolean" ? { defaultValue: schema.default } : {}),
    };
  }
  if (type === "number" || type === "integer") {
    return {
      ...base,
      kind: type,
      ...(typeof schema.default === "number" ? { defaultValue: schema.default } : {}),
      ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
    };
  }
  if (type === "string") {
    const options = decodeMcpOptions(schema);
    if (options) {
      return {
        ...base,
        kind: "single_select",
        options,
        ...(typeof schema.default === "string" ? { defaultValue: schema.default } : {}),
      };
    }
    const format = schema.format === "email" || schema.format === "uri" || schema.format === "date" || schema.format === "date-time"
      ? schema.format
      : undefined;
    return {
      ...base,
      kind: "string",
      ...(format ? { format } : {}),
      ...(typeof schema.default === "string" ? { defaultValue: schema.default } : {}),
      ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
      ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
    };
  }
  if (type === "array") {
    const items = asRecord(schema.items);
    const options = items ? decodeMcpOptions(items) : null;
    if (!options) return null;
    const defaultValue = Array.isArray(schema.default)
      ? schema.default.filter((item): item is string => typeof item === "string")
      : undefined;
    return {
      ...base,
      kind: "multi_select",
      options,
      ...(defaultValue ? { defaultValue } : {}),
      ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
      ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
    };
  }
  return null;
}

function decodeMcpOptions(schema: Record<string, unknown>): InteractiveMcpElicitationOption[] | null {
  if (Array.isArray(schema.oneOf)) {
    const options = schema.oneOf.map(decodeMcpOption).filter((option) => option !== null);
    return options.length === schema.oneOf.length && options.length ? options : null;
  }
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf.map(decodeMcpOption).filter((option) => option !== null);
    return options.length === schema.anyOf.length && options.length ? options : null;
  }
  if (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every((item) => typeof item === "string")) return null;
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return schema.enum.map((value, index) => ({
    value,
    label: typeof names[index] === "string" ? names[index] as string : value,
  }));
}

function decodeMcpOption(value: unknown): InteractiveMcpElicitationOption | null {
  const option = asRecord(value);
  if (!option || typeof option.const !== "string") return null;
  return { value: option.const, label: stringValue(option.title) || option.const };
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function decodeUserInputQuestion(value: unknown): InteractiveUserInputQuestion | null {
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
    multiSelect: question.multiSelect === true,
  };
}

function decodeUserInputOption(value: unknown): InteractiveUserInputOption | null {
  const option = asRecord(value);
  if (!option) return null;
  const label = stringValue(option.label);
  const description = stringValue(option.description);
  return label && description ? { label, description } : null;
}

function approval(
  id: unknown,
  method: string,
  kind: InteractiveApprovalRequest["kind"],
  reason: string,
  details: string,
  params: Record<string, unknown>,
  legacy: boolean,
): InteractiveApprovalRequest {
  const command = kind === "command" ? details || undefined : undefined;
  return {
    type: "approval",
    requestId: id,
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

function decisionList(value: unknown, fallback: InteractiveApprovalDecision[]): InteractiveApprovalDecision[] {
  if (!Array.isArray(value)) return fallback;
  const decisions = value.filter((decision): decision is InteractiveApprovalDecision =>
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
