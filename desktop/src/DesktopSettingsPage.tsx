import { useEffect, useState } from "react";
import {
  getDesktopSettings,
  saveDesktopSettings,
  type DesktopSettings,
  type ExplainProvider,
} from "./desktop-api";
import { applyDesktopAppearance, type DesktopAppearance } from "./desktop-theme";

const emptySettings: DesktopSettings = {
  appearance: "warm-dark",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  explainInstructions: "You are a code reviewer helping developers understand changes. Explain git patches concisely - what changed, what it does, and why it likely matters. The current complete file is supplied for surrounding context; the patch is authoritative about the change itself. Be brief (2-4 sentences for small changes, a short paragraph for complex ones). Skip obvious details like 'a line was added'. Focus on intent and impact.",
  anthropicKeyConfigured: false,
  localKeyConfigured: false,
  openRouterKeyConfigured: false,
};

export default function DesktopSettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState(emptySettings);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [localApiKey, setLocalApiKey] = useState("");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [clearAnthropicApiKey, setClearAnthropicApiKey] = useState(false);
  const [clearLocalApiKey, setClearLocalApiKey] = useState(false);
  const [clearOpenRouterApiKey, setClearOpenRouterApiKey] = useState(false);
  const [status, setStatus] = useState("loading...");

  useEffect(() => {
    getDesktopSettings()
      .then((value) => {
        setSettings(value);
        setStatus("");
      })
      .catch((reason: unknown) => {
        setStatus(reason instanceof Error ? reason.message : "Could not load settings.");
      });
  }, []);

  function set<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setStatus("saving...");
    try {
      const saved = await saveDesktopSettings({
        appearance: settings.appearance,
        provider: settings.provider,
        model: settings.model,
        localBaseUrl: settings.localBaseUrl,
        explainInstructions: settings.explainInstructions,
        anthropicApiKey,
        localApiKey,
        openRouterApiKey,
        clearAnthropicApiKey,
        clearLocalApiKey,
        clearOpenRouterApiKey,
      });
      setSettings(saved);
      setAnthropicApiKey("");
      setLocalApiKey("");
      setOpenRouterApiKey("");
      setClearAnthropicApiKey(false);
      setClearLocalApiKey(false);
      setClearOpenRouterApiKey(false);
      setStatus("Saved.");
    } catch (reason: unknown) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const local = settings.provider === "openai-compatible";
  const openRouter = settings.provider === "openrouter";
  const disabled = status === "loading..." || status === "saving...";

  return (
    <section className="settings-page desktop-settings-page">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack}>&larr; sessions</button>
        <h2>Settings</h2>
        <span className="desktop-settings-badge">native</span>
      </div>
      <div className="settings-grid">
        <section className="settings-card">
          <div className="desktop-appearance-heading">
            <div>
              <h3>Appearance</h3>
              <p>Preview a desktop workspace colorway. The terminal always stays dark.</p>
            </div>
          </div>
          <div className="desktop-appearance-picker" role="radiogroup" aria-label="Desktop appearance">
            <AppearanceOption
              appearance="warm-dark"
              title="Amber night"
              detail="Black with warm yellow"
              selected={settings.appearance === "warm-dark"}
              onSelect={(appearance) => {
                set("appearance", appearance);
                applyDesktopAppearance(appearance);
              }}
            />
            <AppearanceOption
              appearance="blue-dark"
              title="Blue hour"
              detail="Charcoal with pale blue"
              selected={settings.appearance === "blue-dark"}
              onSelect={(appearance) => {
                set("appearance", appearance);
                applyDesktopAppearance(appearance);
              }}
            />
            <AppearanceOption
              appearance="light"
              title="Paper light"
              detail="White with charcoal text"
              selected={settings.appearance === "light"}
              onSelect={(appearance) => {
                set("appearance", appearance);
                applyDesktopAppearance(appearance);
              }}
            />
          </div>
        </section>

        <section className="settings-card">
          <h3>Explain model</h3>
          <p>Choose the provider behind each desktop diff&apos;s <em>explain</em> button. It does not change the model running Codex or Claude Code.</p>
          <label>
            Provider
            <select value={settings.provider} onChange={(event) => set("provider", event.target.value as ExplainProvider)}>
              <option value="anthropic">Anthropic API</option>
              <option value="openrouter">OpenRouter</option>
              <option value="openai-compatible">Local / OpenAI-compatible</option>
            </select>
          </label>
          <label>
            Model
            <input
              value={settings.model}
              onChange={(event) => set("model", event.target.value)}
              placeholder={local ? "qwen3:8b" : openRouter ? "google/gemini-2.5-flash-lite" : "claude-haiku-4-5"}
            />
          </label>
          <label>
            Explain instructions
            <textarea
              className="desktop-settings-prompt"
              value={settings.explainInstructions}
              onChange={(event) => set("explainInstructions", event.target.value)}
              spellCheck={false}
            />
            <small>The filename, triggering request, diff, and current complete file are attached automatically.</small>
          </label>
          {openRouter ? (
            <>
              <SecretField
                label="OpenRouter API key"
                configured={settings.openRouterKeyConfigured}
                clear={clearOpenRouterApiKey}
                value={openRouterApiKey}
                placeholder="sk-or-v1-..."
                onChange={(value) => { setOpenRouterApiKey(value); setClearOpenRouterApiKey(false); }}
                onToggleClear={() => setClearOpenRouterApiKey((value) => !value)}
              />
              <p className="settings-tip">Recommended for inexpensive summaries: <code>google/gemini-2.5-flash-lite</code>.</p>
            </>
          ) : local ? (
            <>
              <label>
                Endpoint
                <input value={settings.localBaseUrl} onChange={(event) => set("localBaseUrl", event.target.value)} placeholder="http://127.0.0.1:11434/v1" />
              </label>
              <SecretField
                label="API key"
                configured={settings.localKeyConfigured}
                clear={clearLocalApiKey}
                value={localApiKey}
                placeholder="optional"
                optional
                onChange={(value) => { setLocalApiKey(value); setClearLocalApiKey(false); }}
                onToggleClear={() => setClearLocalApiKey((value) => !value)}
              />
              <p className="settings-tip">Ollama defaults to <code>http://127.0.0.1:11434/v1</code>. LM Studio works with its OpenAI-compatible server enabled.</p>
            </>
          ) : (
            <SecretField
              label="Anthropic API key"
              configured={settings.anthropicKeyConfigured}
              clear={clearAnthropicApiKey}
              value={anthropicApiKey}
              placeholder="sk-ant-..."
              onChange={(value) => { setAnthropicApiKey(value); setClearAnthropicApiKey(false); }}
              onToggleClear={() => setClearAnthropicApiKey((value) => !value)}
            />
          )}
        </section>

        <section className="settings-card desktop-settings-info-card">
          <h3>Desktop boundary</h3>
          <p>The native app reads local session history directly through Tauri. It does not start the web server, expose a network listener, or allow remote terminal control.</p>
          <div className="desktop-settings-fact"><span>Session access</span><strong>local only</strong></div>
          <div className="desktop-settings-fact"><span>Saved secrets</span><strong>app config file</strong></div>
          <div className="desktop-settings-fact"><span>Tailscale controls</span><strong>web app only</strong></div>
          <p className="settings-tip">Use the web Settings page if you intentionally want phone/Tailscale access.</p>
        </section>
      </div>
      <div className="settings-actions">
        <button className="settings-save" onClick={() => void save()} disabled={disabled}>save settings</button>
        <span>{status}</span>
      </div>
    </section>
  );
}

function AppearanceOption({
  appearance,
  title,
  detail,
  selected,
  onSelect,
}: {
  appearance: DesktopAppearance;
  title: string;
  detail: string;
  selected: boolean;
  onSelect: (appearance: DesktopAppearance) => void;
}) {
  return (
    <button
      className={`desktop-appearance-option appearance-${appearance}${selected ? " selected" : ""}`}
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(appearance)}
    >
      <span className="desktop-appearance-preview" aria-hidden="true">
        <i /><i /><i /><b />
      </span>
      <span className="desktop-appearance-copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className="desktop-appearance-check">{selected ? "selected" : "select"}</span>
    </button>
  );
}

function SecretField({
  label,
  configured,
  clear,
  value,
  placeholder,
  optional = false,
  onChange,
  onToggleClear,
}: {
  label: string;
  configured: boolean;
  clear: boolean;
  value: string;
  placeholder: string;
  optional?: boolean;
  onChange: (value: string) => void;
  onToggleClear: () => void;
}) {
  const help = clear
    ? "will be removed when saved"
    : configured
      ? "saved locally; leave blank to keep, or enter a replacement"
      : optional
        ? "optional"
        : "required for this provider";
  return (
    <>
      <label>
        {label} <small>{help}</small>
        <input type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "enter a new key to replace" : placeholder} />
      </label>
      {configured && (
        <button className="settings-remove" onClick={onToggleClear}>{clear ? "keep saved key" : "remove saved key"}</button>
      )}
    </>
  );
}
