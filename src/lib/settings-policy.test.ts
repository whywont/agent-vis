import { describe, expect, it } from "vitest";
import { prepareSettingsChange } from "./settings-policy";

const base = { provider: "anthropic", model: "claude-haiku-4-5" };

describe("prepareSettingsChange", () => {
  it("requires a model", () => {
    expect(prepareSettingsChange({ provider: "anthropic", model: " " }, false))
      .toEqual({ ok: false, error: "A model name is required." });
  });

  it("rejects line breaks that could inject additional environment settings", () => {
    expect(prepareSettingsChange({
      ...base,
      authToken: "secret\nAGENT_VIS_ALLOW_REMOTE_TERMINAL=1",
    }, false)).toEqual({
      ok: false,
      error: "Settings values cannot contain line breaks.",
    });
  });

  it("rejects non-HTTP local model endpoints", () => {
    expect(prepareSettingsChange({
      provider: "openai-compatible",
      model: "qwen",
      localBaseUrl: "file:///tmp/model",
    }, false)).toEqual({ ok: false, error: "Use a valid HTTP(S) local model endpoint." });
  });

  it("requires an access token before enabling Tailscale", () => {
    expect(prepareSettingsChange({ ...base, tailscaleHost: "100.64.0.10" }, false))
      .toEqual({ ok: false, error: "Set an access token before enabling Tailscale access." });
  });

  it("preserves access when a token is already configured", () => {
    const result = prepareSettingsChange({ ...base, tailscaleHost: "device.tailnet.ts.net" }, true);
    expect(result.ok && result.value.updates.HOSTS)
      .toBe("127.0.0.1,device.tailnet.ts.net");
  });

  it("rejects clearing the saved token while Tailscale remains enabled", () => {
    expect(prepareSettingsChange({
      ...base,
      tailscaleHost: "100.64.0.10",
      clearAuthToken: true,
    }, true)).toEqual({ ok: false, error: "Set an access token before enabling Tailscale access." });
  });

  it("trims secrets and records explicit key removal", () => {
    const result = prepareSettingsChange({
      ...base,
      authToken: "  secret-token  ",
      clearAnthropicApiKey: true,
    }, false);
    expect(result.ok && result.value.updates.AGENT_VIS_AUTH_TOKEN).toBe("secret-token");
    expect(result.ok && result.value.keysToClear).toContain("ANTHROPIC_API_KEY");
  });

  it("keeps remote terminal access disabled unless explicitly enabled", () => {
    const disabled = prepareSettingsChange(base, false);
    const enabled = prepareSettingsChange({ ...base, remoteTerminal: true }, false);
    expect(disabled.ok && disabled.value.updates.AGENT_VIS_ALLOW_REMOTE_TERMINAL).toBe("0");
    expect(enabled.ok && enabled.value.updates.AGENT_VIS_ALLOW_REMOTE_TERMINAL).toBe("1");
  });

  it("does not clear a secret when the same save supplies its replacement", () => {
    const result = prepareSettingsChange({
      ...base,
      anthropicApiKey: "new-secret",
      clearAnthropicApiKey: true,
    }, false);
    expect(result.ok && result.value.updates.ANTHROPIC_API_KEY).toBe("new-secret");
    expect(result.ok && result.value.keysToClear).not.toContain("ANTHROPIC_API_KEY");
  });
});
