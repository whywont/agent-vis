import type { ExplainProvider } from "./runtime-settings";

export interface PreparedSettingsChange {
  updates: Record<string, string>;
  keysToClear: string[];
}

export type SettingsPolicyResult =
  | { ok: true; value: PreparedSettingsChange }
  | { ok: false; error: string };

export function prepareSettingsChange(
  body: Record<string, unknown>,
  authConfigured: boolean,
): SettingsPolicyResult {
  const persistedFields = [
    "model",
    "localBaseUrl",
    "tailscaleHost",
    "anthropicApiKey",
    "localApiKey",
    "openRouterApiKey",
    "authToken",
  ];
  if (persistedFields.some((field) => typeof body[field] === "string" && /[\r\n]/.test(body[field]))) {
    return { ok: false, error: "Settings values cannot contain line breaks." };
  }

  const provider: ExplainProvider = body.provider === "openai-compatible" || body.provider === "openrouter"
    ? body.provider
    : "anthropic";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const localBaseUrl = typeof body.localBaseUrl === "string"
    ? body.localBaseUrl.trim().replace(/\/$/, "")
    : "";
  const tailscaleHost = typeof body.tailscaleHost === "string" ? body.tailscaleHost.trim() : "";

  if (!model) return { ok: false, error: "A model name is required." };
  if (provider === "openai-compatible") {
    try {
      const url = new URL(localBaseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      return { ok: false, error: "Use a valid HTTP(S) local model endpoint." };
    }
  }
  if (tailscaleHost && !/^[A-Za-z0-9.:_-]+$/.test(tailscaleHost)) {
    return { ok: false, error: "Tailscale host must be an IP address or hostname." };
  }

  const suppliedAuthToken = typeof body.authToken === "string" && Boolean(body.authToken.trim());
  const willHaveAuthToken = suppliedAuthToken || (authConfigured && body.clearAuthToken !== true);
  if (tailscaleHost && !willHaveAuthToken) {
    return { ok: false, error: "Set an access token before enabling Tailscale access." };
  }

  const updates: Record<string, string> = {
    AGENT_VIS_EXPLAIN_PROVIDER: provider,
    AGENT_VIS_EXPLAIN_MODEL: model,
    AGENT_VIS_LOCAL_BASE_URL: localBaseUrl || "http://127.0.0.1:11434/v1",
    HOSTS: tailscaleHost ? `127.0.0.1,${tailscaleHost}` : "127.0.0.1",
    AGENT_VIS_ALLOW_REMOTE_TERMINAL: body.remoteTerminal === true ? "1" : "0",
  };
  const secrets = [
    ["anthropicApiKey", "clearAnthropicApiKey", "ANTHROPIC_API_KEY"],
    ["localApiKey", "clearLocalApiKey", "AGENT_VIS_LOCAL_API_KEY"],
    ["openRouterApiKey", "clearOpenRouterApiKey", "OPENROUTER_API_KEY"],
    ["authToken", "clearAuthToken", "AGENT_VIS_AUTH_TOKEN"],
  ] as const;
  for (const [field, , key] of secrets) {
    const value = body[field];
    if (typeof value === "string" && value.trim()) updates[key] = value.trim();
  }

  const keysToClear = secrets
    .filter(([field, clearFlag]) => {
      const replacement = body[field];
      return body[clearFlag] === true
        && !(typeof replacement === "string" && replacement.trim());
    })
    .map(([, , key]) => key);

  return { ok: true, value: { updates, keysToClear } };
}
