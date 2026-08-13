import type {
  InteractiveMcpElicitationField,
  InteractiveMcpElicitationOption,
  InteractiveMcpElicitationRequest,
} from "./interactive-agent-requests";

export function decodeMcpElicitationRequest(
  requestId: unknown,
  method: string,
  params: Record<string, unknown>,
): InteractiveMcpElicitationRequest {
  const rawMode = stringValue(params.mode);
  const mode: InteractiveMcpElicitationRequest["mode"] = rawMode === "form" || rawMode === "url" || rawMode === "openai/form"
    ? rawMode
    : "unknown";
  const elicitationId = stringValue(params.elicitationId);
  const base = {
    type: "mcp_elicitation" as const,
    requestId,
    method,
    mode,
    serverName: stringValue(params.serverName) || "MCP server",
    message: stringValue(params.message) || "This MCP server needs additional input.",
    fields: [] as InteractiveMcpElicitationField[],
    ...(elicitationId ? { elicitationId } : {}),
  };

  if (mode === "url") {
    const url = safeHttpUrl(params.url);
    return url
      ? { ...base, url, canAccept: true }
      : { ...base, canAccept: false, unsupportedReason: "The request URL is missing or is not an HTTP(S) URL." };
  }
  if (mode !== "form" && mode !== "openai/form") {
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
    ...(!fullySupported ? {
      unsupportedReason: mode === "openai/form"
        ? "The extended form contains field types Agent Vis cannot render safely."
        : "The form contains field types Agent Vis cannot render safely.",
    } : {}),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
