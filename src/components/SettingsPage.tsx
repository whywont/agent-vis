"use client";

import { useEffect, useState } from "react";

type Settings = {
  provider: "anthropic" | "openai-compatible" | "openrouter";
  model: string;
  localBaseUrl: string;
  tailscaleHost: string;
  remoteTerminal: boolean;
  remoteAgentChat: boolean;
  authConfigured: boolean;
  anthropicKeyConfigured: boolean;
  localKeyConfigured: boolean;
  openRouterKeyConfigured: boolean;
};

const empty: Settings = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  tailscaleHost: "",
  remoteTerminal: false,
  remoteAgentChat: false,
  authConfigured: false,
  anthropicKeyConfigured: false,
  localKeyConfigured: false,
  openRouterKeyConfigured: false,
};

export default function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings>(empty);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [localApiKey, setLocalApiKey] = useState("");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [clearAnthropicApiKey, setClearAnthropicApiKey] = useState(false);
  const [clearLocalApiKey, setClearLocalApiKey] = useState(false);
  const [clearOpenRouterApiKey, setClearOpenRouterApiKey] = useState(false);
  const [clearAuthToken, setClearAuthToken] = useState(false);
  const [status, setStatus] = useState("loading…");

  async function loadSettings() {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data: Settings) => { setSettings(data); setStatus(""); })
      .catch(() => setStatus("Could not load settings."));
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setStatus("saving…");
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...settings, anthropicApiKey, localApiKey, openRouterApiKey, authToken,
        clearAnthropicApiKey, clearLocalApiKey, clearOpenRouterApiKey, clearAuthToken,
      }),
    });
    setStatus(res.ok ? "Saved. Explain-model changes apply on the next request; restart agent-vis for Tailscale, mobile chat, or raw-terminal access changes." : await res.text());
    if (res.ok) {
      setAnthropicApiKey("");
      setLocalApiKey("");
      setOpenRouterApiKey("");
      setAuthToken("");
      setClearAnthropicApiKey(false);
      setClearLocalApiKey(false);
      setClearOpenRouterApiKey(false);
      setClearAuthToken(false);
      await loadSettings();
    }
  }

  const local = settings.provider === "openai-compatible";
  const openRouter = settings.provider === "openrouter";
  return (
    <section className="settings-page">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack}>← sessions</button>
        <h2>Settings</h2>
      </div>
      <div className="settings-grid">
        <section className="settings-card">
          <h3>Explain model</h3>
          <p>Controls the model behind each diff’s <em>explain</em> button; it does not change Codex’s own model.</p>
          <label>Provider
            <select value={settings.provider} onChange={(e) => set("provider", e.target.value as Settings["provider"])}>
              <option value="anthropic">Anthropic API</option>
              <option value="openrouter">OpenRouter</option>
              <option value="openai-compatible">Local / OpenAI-compatible</option>
            </select>
          </label>
          <label>Model
            <input value={settings.model} onChange={(e) => set("model", e.target.value)} placeholder={local ? "qwen3:8b" : openRouter ? "google/gemini-2.5-flash-lite" : "claude-haiku-4-5"} />
          </label>
          {openRouter ? <>
            <label>OpenRouter API key <small>{clearOpenRouterApiKey ? "will be removed when saved" : settings.openRouterKeyConfigured ? "saved locally; leave blank to keep, or enter a replacement" : "required"}</small>
              <input type="password" value={openRouterApiKey} onChange={(e) => { setOpenRouterApiKey(e.target.value); setClearOpenRouterApiKey(false); }} placeholder={settings.openRouterKeyConfigured ? "enter a new key to replace" : "sk-or-v1-…"} />
            </label>
            {settings.openRouterKeyConfigured && <button className="settings-remove" onClick={() => setClearOpenRouterApiKey((clear) => !clear)}>{clearOpenRouterApiKey ? "keep saved key" : "remove saved key"}</button>}
            <p className="settings-tip">Recommended for cheap summaries: <code>google/gemini-2.5-flash-lite</code>. It uses no local RAM.</p>
          </> : local ? <>
            <label>Endpoint
              <input value={settings.localBaseUrl} onChange={(e) => set("localBaseUrl", e.target.value)} placeholder="http://127.0.0.1:11434/v1" />
            </label>
            <label>API key <small>{clearLocalApiKey ? "will be removed when saved" : settings.localKeyConfigured ? "saved locally; leave blank to keep, or enter a replacement" : "optional for Ollama"}</small>
              <input type="password" value={localApiKey} onChange={(e) => { setLocalApiKey(e.target.value); setClearLocalApiKey(false); }} placeholder={settings.localKeyConfigured ? "enter a new key to replace" : "optional"} />
            </label>
            {settings.localKeyConfigured && <button className="settings-remove" onClick={() => setClearLocalApiKey((clear) => !clear)}>{clearLocalApiKey ? "keep saved key" : "remove saved key"}</button>}
            <p className="settings-tip">Ollama default: <code>http://127.0.0.1:11434/v1</code>. LM Studio works too when its OpenAI-compatible server is enabled.</p>
          </> : <>
            <label>Anthropic API key <small>{clearAnthropicApiKey ? "will be removed when saved" : settings.anthropicKeyConfigured ? "saved locally; leave blank to keep, or enter a replacement" : "required"}</small>
              <input type="password" value={anthropicApiKey} onChange={(e) => { setAnthropicApiKey(e.target.value); setClearAnthropicApiKey(false); }} placeholder={settings.anthropicKeyConfigured ? "enter a new key to replace" : "sk-ant-…"} />
            </label>
            {settings.anthropicKeyConfigured && <button className="settings-remove" onClick={() => setClearAnthropicApiKey((clear) => !clear)}>{clearAnthropicApiKey ? "keep saved key" : "remove saved key"}</button>}
          </>}
        </section>
        <section className="settings-card">
          <h3>Tailscale access</h3>
          <p>Agent Vis stays local unless you enter this Mac’s Tailscale IP or MagicDNS hostname. A restart is required because the server must rebind.</p>
          <label>Tailscale IP or hostname
            <input value={settings.tailscaleHost} onChange={(e) => set("tailscaleHost", e.target.value)} placeholder="100.x.y.z or your-mac.tailnet.ts.net" />
          </label>
          <label>Access token <small>{clearAuthToken ? "will be removed when saved" : settings.authConfigured ? "saved locally; leave blank to keep, or enter a replacement" : "required for Tailscale"}</small>
            <input type="password" value={authToken} onChange={(e) => { setAuthToken(e.target.value); setClearAuthToken(false); }} placeholder={settings.authConfigured ? "enter a new token to replace" : "long random token"} />
          </label>
          {settings.authConfigured && <button className="settings-remove" onClick={() => setClearAuthToken((clear) => !clear)}>{clearAuthToken ? "keep saved token" : "remove saved token"}</button>}
          <label className="settings-checkbox">
            <input type="checkbox" checked={settings.remoteAgentChat} onChange={(e) => set("remoteAgentChat", e.target.checked)} />
            Allow mobile agent chat from Tailscale devices
          </label>
          <p className="settings-tip">Shows a phone-friendly composer and session timeline. It does not expose the raw terminal.</p>
          <label className="settings-checkbox">
            <input type="checkbox" checked={settings.remoteTerminal} onChange={(e) => set("remoteTerminal", e.target.checked)} />
            Allow raw terminal control from Tailscale devices
          </label>
          <p className="settings-tip">Leave raw terminal off unless you specifically need shell access in the browser.</p>
        </section>
      </div>
      <div className="settings-actions">
        <button className="settings-save" onClick={save} disabled={status === "loading…" || status === "saving…"}>save settings</button>
        <span>{status}</span>
      </div>
    </section>
  );
}
