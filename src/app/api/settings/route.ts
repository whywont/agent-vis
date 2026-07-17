import { NextRequest, NextResponse } from "next/server";
import { getRuntimeSettings, removeRuntimeSettings, saveRuntimeSettings } from "@/lib/runtime-settings";

export async function GET() {
  const settings = await getRuntimeSettings();
  return NextResponse.json({
    ...settings,
    localApiKey: undefined,
    openRouterApiKey: undefined,
    anthropicApiKey: undefined,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  const provider = body.provider === "openai-compatible" || body.provider === "openrouter"
    ? body.provider
    : "anthropic";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const localBaseUrl = typeof body.localBaseUrl === "string" ? body.localBaseUrl.trim().replace(/\/$/, "") : "";
  const tailscaleHost = typeof body.tailscaleHost === "string" ? body.tailscaleHost.trim() : "";
  const remoteTerminal = body.remoteTerminal === true;
  if (!model) return new Response("A model name is required.", { status: 400 });
  if (provider === "openai-compatible") {
    try {
      const url = new URL(localBaseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      return new Response("Use a valid HTTP(S) local model endpoint.", { status: 400 });
    }
  }
  if (tailscaleHost && !/^[A-Za-z0-9.:_-]+$/.test(tailscaleHost)) {
    return new Response("Tailscale host must be an IP address or hostname.", { status: 400 });
  }
  const updates: Record<string, string> = {
    AGENT_VIS_EXPLAIN_PROVIDER: provider,
    AGENT_VIS_EXPLAIN_MODEL: model,
    AGENT_VIS_LOCAL_BASE_URL: localBaseUrl || "http://127.0.0.1:11434/v1",
    HOSTS: tailscaleHost ? `127.0.0.1,${tailscaleHost}` : "127.0.0.1",
    AGENT_VIS_ALLOW_REMOTE_TERMINAL: remoteTerminal ? "1" : "0",
  };
  if (typeof body.anthropicApiKey === "string" && body.anthropicApiKey.trim()) {
    updates.ANTHROPIC_API_KEY = body.anthropicApiKey.trim();
  }
  if (typeof body.localApiKey === "string" && body.localApiKey.trim()) {
    updates.AGENT_VIS_LOCAL_API_KEY = body.localApiKey.trim();
  }
  if (typeof body.openRouterApiKey === "string" && body.openRouterApiKey.trim()) {
    updates.OPENROUTER_API_KEY = body.openRouterApiKey.trim();
  }
  if (typeof body.authToken === "string" && body.authToken.trim()) {
    updates.AGENT_VIS_AUTH_TOKEN = body.authToken.trim();
  }
  const existingSettings = await getRuntimeSettings();
  const suppliedAuthToken = typeof body.authToken === "string" && Boolean(body.authToken.trim());
  const willHaveAuthToken = suppliedAuthToken || (existingSettings.authConfigured && body.clearAuthToken !== true);
  if (tailscaleHost && !willHaveAuthToken) {
    return new Response("Set an access token before enabling Tailscale access.", { status: 400 });
  }
  await saveRuntimeSettings(updates);
  const clearable = [
    ["clearAnthropicApiKey", "ANTHROPIC_API_KEY", body.anthropicApiKey],
    ["clearLocalApiKey", "AGENT_VIS_LOCAL_API_KEY", body.localApiKey],
    ["clearOpenRouterApiKey", "OPENROUTER_API_KEY", body.openRouterApiKey],
    ["clearAuthToken", "AGENT_VIS_AUTH_TOKEN", body.authToken],
  ] as const;
  const keysToClear = clearable
    .filter(([flag, , replacement]) => body[flag] === true && !(typeof replacement === "string" && replacement.trim()))
    .map(([, key]) => key);
  if (keysToClear.length) await removeRuntimeSettings(keysToClear);
  return NextResponse.json({ restartRequired: true });
}
