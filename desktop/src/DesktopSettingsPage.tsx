import { useEffect, useState } from "react";
import {
  getDesktopSettings,
  getMeshStatus,
  regenerateMeshIdentity,
  connectMeshPeer,
  saveDesktopSettings,
  type DesktopSettings,
  type ExplainProvider,
  type PairedDevice,
  type MeshStatus,
  type SessionSharingMode,
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
  sessionSharingMode: "off",
  pairedDevices: [],
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
  const [deviceName, setDeviceName] = useState("");
  const [deviceEndpoint, setDeviceEndpoint] = useState("");
  const [devicePublicKey, setDevicePublicKey] = useState("");
  const [meshStatus, setMeshStatus] = useState<MeshStatus | null>(null);
  const [syncingDeviceId, setSyncingDeviceId] = useState<string | null>(null);
  const [deviceSyncResults, setDeviceSyncResults] = useState<Record<string, { connected: boolean; detail: string }>>({});
  const [identityCopied, setIdentityCopied] = useState(false);
  const [confirmIdentityReset, setConfirmIdentityReset] = useState(false);
  const [regeneratingIdentity, setRegeneratingIdentity] = useState(false);

  useEffect(() => {
    getDesktopSettings()
      .then((value) => {
        setSettings(value);
        setStatus("");
      })
      .catch((reason: unknown) => {
        setStatus(reason instanceof Error ? reason.message : "Could not load settings.");
      });
    getMeshStatus().then(setMeshStatus).catch(() => {
      // The remainder of Settings still works when the mesh listener is unavailable.
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
        sessionSharingMode: settings.sessionSharingMode,
        pairedDevices: settings.pairedDevices,
      });
      setSettings(saved);
      setMeshStatus(await getMeshStatus());
      // The sidebar reloads its complete sharing state from persisted settings.
      window.dispatchEvent(new CustomEvent("session-sharing-settings-changed"));
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

  async function persistSettings(pairedDevices: PairedDevice[]) {
    return saveDesktopSettings({
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
      sessionSharingMode: settings.sessionSharingMode,
      pairedDevices,
    });
  }

  async function saveAndSync(device: PairedDevice) {
    setSyncingDeviceId(device.id);
    setDeviceSyncResults((current) => ({
      ...current,
      [device.id]: { connected: false, detail: "Waiting for peer response..." },
    }));
    setStatus("Saving peer configuration...");
    try {
      const pairedDevices = settings.pairedDevices.map((item) => ({
        ...item,
        endpoint: meshEndpoint(item.endpoint),
      }));
      const saved = await persistSettings(pairedDevices);
      setSettings(saved);
      window.dispatchEvent(new CustomEvent("session-sharing-settings-changed"));
      setStatus(`Connecting to ${device.name}...`);
      const result = await connectMeshPeer(device.id);
      setStatus(result.detail);
      setDeviceSyncResults((current) => ({ ...current, [device.id]: result }));
      if (result.connected) window.dispatchEvent(new CustomEvent("mesh-sessions-synced"));
      setMeshStatus(await getMeshStatus());
    } catch (reason: unknown) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setStatus(detail);
      setDeviceSyncResults((current) => ({
        ...current,
        [device.id]: { connected: false, detail },
      }));
    } finally {
      setSyncingDeviceId(null);
    }
  }

  const local = settings.provider === "openai-compatible";
  const openRouter = settings.provider === "openrouter";
  const disabled = status === "loading..." || status === "saving...";
  const deviceDraftReady = validDeviceDraft(deviceName, deviceEndpoint, devicePublicKey);
  const connectedPeer = meshStatus?.peers.some((peer) => peer.connected) ?? false;

  async function addDevice() {
    const name = deviceName.trim();
    const endpoint = meshEndpoint(deviceEndpoint);
    const publicKey = devicePublicKey.trim();
    if (!name || !endpoint || !publicKey) {
      setStatus("Enter a device name, address, and identity key.");
      return;
    }
    const device: PairedDevice = {
      id: crypto.randomUUID(),
      name,
      endpoint,
      publicKey,
    };
    setStatus("Saving device...");
    try {
      const saved = await persistSettings([...settings.pairedDevices, device]);
      setSettings(saved);
      setMeshStatus(await getMeshStatus());
      window.dispatchEvent(new CustomEvent("session-sharing-settings-changed"));
      setDeviceName("");
      setDeviceEndpoint("");
      setDevicePublicKey("");
      setStatus("Device saved.");
    } catch (reason: unknown) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function regenerateIdentity() {
    if (!confirmIdentityReset) {
      setConfirmIdentityReset(true);
      setStatus("Confirm regeneration. Existing devices must save the new public identity.");
      return;
    }
    setRegeneratingIdentity(true);
    try {
      const next = await regenerateMeshIdentity();
      setMeshStatus(next);
      setDeviceSyncResults({});
      setConfirmIdentityReset(false);
      setStatus("Mesh identity regenerated. Copy the new public ID to every paired Mac.");
    } catch (reason: unknown) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRegeneratingIdentity(false);
    }
  }

  return (
    <section className="settings-page desktop-settings-page">
      <div className="settings-header">
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
          <h3>Session sharing</h3>
          <p>Pair devices by their identity key, then share encrypted transcript data. Shared remote sessions are <em>json-only</em>: they do not include a live agent, terminal, files, or credentials.</p>
          <label>
            Sharing policy
            <select value={settings.sessionSharingMode} onChange={(event) => set("sessionSharingMode", event.target.value as SessionSharingMode)}>
              <option value="off">No sharing</option>
              <option value="selected">Share selected sessions</option>
              <option value="all">Automatically share all sessions</option>
            </select>
          </label>
          <div className="desktop-settings-fact"><span>Transport</span><strong>{connectedPeer ? "peer sync completed" : meshStatus?.listening ? "waiting for peer device" : settings.pairedDevices.some((device) => device.publicKey) ? "listener unavailable" : "off until a peer is saved"}</strong></div>
          <div className="desktop-settings-fact"><span>Remote terminal</span><strong>not shared</strong></div>
        </section>

        <section className="settings-card desktop-settings-info-card">
          <h3>Configured devices</h3>
          <p>Pair a Tailscale or private-network address with the other app&apos;s identity key. Sync sends policy-authorized transcript snapshots in both directions over the authenticated encrypted connection.</p>
          <div className="desktop-mesh-identity">
            <span>This device public ID</span>
            <code className="desktop-mesh-public-key">{meshStatus?.publicKey || "loading..."}</code>
            <div className="desktop-mesh-identity-actions">
              <button type="button" disabled={!meshStatus?.publicKey} onClick={() => {
                navigator.clipboard.writeText(meshStatus?.publicKey || "").then(() => {
                  setIdentityCopied(true);
                  window.setTimeout(() => setIdentityCopied(false), 1400);
                }).catch(() => setStatus("Could not copy the public identity."));
              }}>{identityCopied ? "copied" : "copy public ID"}</button>
              <button
                type="button"
                className={confirmIdentityReset ? "confirm" : ""}
                disabled={regeneratingIdentity}
                onClick={() => void regenerateIdentity()}
              >
                {regeneratingIdentity ? "regenerating..." : confirmIdentityReset ? "confirm regenerate" : "regenerate identity"}
              </button>
            </div>
            <small>The private identity stays in macOS Keychain. Regenerating invalidates this Mac&apos;s existing pairings.</small>
          </div>
          {settings.pairedDevices.length ? (
            <div className="desktop-paired-devices">
              {settings.pairedDevices.map((device) => (
                <div key={device.id} className="desktop-paired-device">
                  <div className="desktop-paired-device-copy">
                    <strong>{device.name}</strong>
                    <code>{meshEndpoint(device.endpoint)}</code>
                    <small className={device.publicKey ? "configured" : "missing"}>
                      {device.publicKey ? "Identity key pinned" : "Identity key missing"}
                    </small>
                    {(deviceSyncResults[device.id] || meshStatus?.peers.find((peer) => peer.id === device.id))?.detail ? (
                      <small className={(deviceSyncResults[device.id] || meshStatus?.peers.find((peer) => peer.id === device.id))?.connected ? "connected" : syncingDeviceId === device.id ? "connecting" : "failed"}>
                        {(deviceSyncResults[device.id] || meshStatus?.peers.find((peer) => peer.id === device.id))?.detail}
                      </small>
                    ) : device.publicKey ? (
                      <small className="waiting">Waiting for peer device - open Agent Vis on both Macs</small>
                    ) : null}
                  </div>
                  <div className="desktop-paired-device-actions">
                    <button
                      type="button"
                      className="desktop-peer-sync"
                      disabled={!device.publicKey || syncingDeviceId !== null}
                      onClick={() => void saveAndSync(device)}
                    >
                      {syncingDeviceId === device.id ? "syncing..." : "sync now"}
                    </button>
                    <button
                      type="button"
                      className="desktop-peer-remove"
                      disabled={syncingDeviceId !== null}
                      onClick={() => set("pairedDevices", settings.pairedDevices.filter((item) => item.id !== device.id))}
                    >
                      remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="settings-tip">No devices configured yet.</p>}
          <label>
            Device name
            <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="MacBook Air" />
          </label>
          <label>
            Tailscale or manual address
            <input value={deviceEndpoint} onChange={(event) => setDeviceEndpoint(event.target.value)} placeholder="100.64.0.12:4242" spellCheck={false} />
          </label>
          <label>
            Device identity key
            <input value={devicePublicKey} onChange={(event) => setDevicePublicKey(event.target.value)} placeholder="Paste the other device's identity key" spellCheck={false} />
          </label>
          <div className="desktop-device-save-row">
            <button
              type="button"
              className={`desktop-device-save${deviceDraftReady ? " ready" : ""}`}
              disabled={disabled || !deviceDraftReady}
              onClick={() => void addDevice()}
            >
              save device
            </button>
            <small>{deviceDraftReady ? "Ready to save" : "Enter a name, address, and valid identity key"}</small>
          </div>
        </section>

        <section className="settings-card desktop-settings-info-card">
          <h3>Desktop boundary</h3>
          <p>The native app reads local session history directly through Tauri. Mesh transcript sharing does not add remote terminal control; the existing phone remote-terminal feature is unchanged.</p>
          <div className="desktop-settings-fact"><span>Session access</span><strong>local + synced transcripts</strong></div>
          <div className="desktop-settings-fact"><span>Saved secrets</span><strong>OS keychain</strong></div>
          <div className="desktop-settings-fact"><span>Tailscale controls</span><strong>manual peer setup</strong></div>
        </section>
      </div>
      <div className="settings-actions">
        <button className="settings-save" onClick={() => void save()} disabled={disabled}>save settings</button>
        <span>{status}</span>
      </div>
    </section>
  );
}

function meshEndpoint(value: string): string {
  const endpoint = value.trim();
  if (!endpoint) return endpoint;
  if (/^\[[^\]]+\]:\d+$/.test(endpoint) || /^[^:]+:\d+$/.test(endpoint)) return endpoint;
  if (/^\[[^\]]+\]$/.test(endpoint)) return `${endpoint}:4242`;
  if ((endpoint.match(/:/g) || []).length > 1) return `[${endpoint}]:4242`;
  return `${endpoint}:4242`;
}

function validDeviceDraft(name: string, endpoint: string, publicKey: string): boolean {
  const normalizedEndpoint = meshEndpoint(endpoint);
  return name.trim().length > 0
    && name.trim().length <= 128
    && normalizedEndpoint.length <= 512
    && !normalizedEndpoint.includes(" ")
    && (/^\[[^\]]+\]:\d+$/.test(normalizedEndpoint) || /^[^:]+:\d+$/.test(normalizedEndpoint))
    && /^[A-Za-z0-9+/]{43}$/.test(publicKey.trim());
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
