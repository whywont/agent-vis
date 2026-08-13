export type InteractiveApprovalDecision = string | Record<string, unknown>;

export type InteractiveApprovalRequest = {
  type: "approval";
  requestId: unknown;
  method: string;
  kind: "command" | "file" | "permissions";
  reason: string;
  details: string;
  decisions: InteractiveApprovalDecision[];
  permissions?: unknown;
  command?: string;
  legacy: boolean;
};

export type InteractiveUserInputOption = {
  label: string;
  description: string;
};

export type InteractiveUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: InteractiveUserInputOption[];
  isOther: boolean;
  isSecret: boolean;
};

export type InteractiveUserInputRequest = {
  type: "user_input";
  requestId: unknown;
  method: string;
  questions: InteractiveUserInputQuestion[];
  autoResolutionMs?: number;
};

export type InteractiveMcpElicitationValue = string | number | boolean | string[];

export type InteractiveMcpElicitationOption = {
  value: string;
  label: string;
};

export type InteractiveMcpElicitationField = {
  id: string;
  title: string;
  description: string;
  required: boolean;
  kind: "string" | "number" | "integer" | "boolean" | "single_select" | "multi_select";
  format?: "email" | "uri" | "date" | "date-time";
  options?: InteractiveMcpElicitationOption[];
  defaultValue?: InteractiveMcpElicitationValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

export type InteractiveMcpElicitationRequest = {
  type: "mcp_elicitation";
  requestId: unknown;
  method: string;
  mode: "form" | "url" | "openai/form" | "unknown";
  serverName: string;
  message: string;
  fields: InteractiveMcpElicitationField[];
  url?: string;
  canAccept: boolean;
  unsupportedReason?: string;
};

export type InteractiveAgentRequest =
  | InteractiveApprovalRequest
  | InteractiveUserInputRequest
  | InteractiveMcpElicitationRequest;

export type UnsupportedInteractiveAgentRequest = {
  type: "unsupported";
  requestId: unknown;
  method: string;
  description: string;
};

export type DecodedInteractiveAgentRequest = InteractiveAgentRequest | UnsupportedInteractiveAgentRequest;

export type InteractiveAgentResponse =
  | { type: "approval"; decision: InteractiveApprovalDecision }
  | { type: "user_input"; answers: Record<string, string> }
  | {
    type: "mcp_elicitation";
    action: "accept" | "decline" | "cancel";
    content: Record<string, InteractiveMcpElicitationValue>;
  };

export function mcpElicitationDefaults(
  request: InteractiveMcpElicitationRequest,
): Record<string, InteractiveMcpElicitationValue> {
  return Object.fromEntries(request.fields.flatMap((field) => {
    if (field.defaultValue !== undefined) return [[field.id, field.defaultValue]];
    if (field.kind === "boolean" && field.required) return [[field.id, false]];
    return [];
  }));
}

export function mcpFieldSatisfied(
  field: InteractiveMcpElicitationField,
  value: InteractiveMcpElicitationValue | undefined,
): boolean {
  if (Array.isArray(value)) {
    const minimum = field.minItems ?? (field.required ? 1 : 0);
    return value.length >= minimum && (field.maxItems === undefined || value.length <= field.maxItems);
  }
  if (!field.required && (value === undefined || value === "")) return true;
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "number" || field.kind === "integer") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string" && value.trim().length > 0;
}

export function mcpElicitationContent(
  request: InteractiveMcpElicitationRequest,
  values: Record<string, InteractiveMcpElicitationValue>,
): Record<string, InteractiveMcpElicitationValue> {
  return Object.fromEntries(request.fields.flatMap((field) => {
    const value = values[field.id];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0 && !field.required)) return [];
    return [[field.id, value]];
  }));
}
