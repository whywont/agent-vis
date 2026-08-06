use crate::secrets::{
    SecretStore, SystemSecretStore, ANTHROPIC_KEY_ACCOUNT, LOCAL_KEY_ACCOUNT,
    OPENROUTER_KEY_ACCOUNT,
};
use crate::sessions::local_session_key_exists;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_SETTINGS_FILE_BYTES: usize = 64 * 1024;
const MAX_SECRET_LENGTH: usize = 16 * 1024;
const SETTINGS_FILE: &str = "settings.json";
const MAX_EXPLAIN_INSTRUCTIONS_BYTES: usize = 32 * 1024;
const MAX_PAIRED_DEVICES: usize = 32;
const MAX_SHARED_SESSION_KEYS: usize = 10_000;
pub(crate) const DEFAULT_EXPLAIN_INSTRUCTIONS: &str = "You are a code reviewer helping developers understand changes. Explain git patches concisely - what changed, what it does, and why it likely matters. The current complete file is supplied for surrounding context; the patch is authoritative about the change itself. Be brief (2-4 sentences for small changes, a short paragraph for complex ones). Skip obvious details like 'a line was added'. Focus on intent and impact.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExplainProvider {
    Anthropic,
    OpenaiCompatible,
    Openrouter,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DesktopAppearance {
    #[default]
    WarmDark,
    BlueDark,
    Light,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SessionSharingMode {
    #[default]
    Off,
    Selected,
    All,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairedDevice {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) endpoint: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSettingsFile {
    #[serde(default)]
    pub(crate) appearance: DesktopAppearance,
    pub(crate) provider: ExplainProvider,
    pub(crate) model: String,
    pub(crate) local_base_url: String,
    #[serde(default = "default_explain_instructions")]
    pub(crate) explain_instructions: String,
    #[serde(default, skip_serializing)]
    pub(crate) anthropic_api_key: String,
    #[serde(default, skip_serializing)]
    pub(crate) local_api_key: String,
    #[serde(default, skip_serializing)]
    pub(crate) open_router_api_key: String,
    #[serde(default)]
    pub(crate) session_sharing_mode: SessionSharingMode,
    #[serde(default)]
    pub(crate) shared_session_keys: Vec<String>,
    #[serde(default)]
    pub(crate) paired_devices: Vec<PairedDevice>,
}

impl Default for DesktopSettingsFile {
    fn default() -> Self {
        Self {
            appearance: DesktopAppearance::default(),
            provider: ExplainProvider::Anthropic,
            model: "claude-haiku-4-5".to_owned(),
            local_base_url: "http://127.0.0.1:11434/v1".to_owned(),
            explain_instructions: default_explain_instructions(),
            anthropic_api_key: String::new(),
            local_api_key: String::new(),
            open_router_api_key: String::new(),
            session_sharing_mode: SessionSharingMode::default(),
            shared_session_keys: Vec::new(),
            paired_devices: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSettings {
    appearance: DesktopAppearance,
    provider: ExplainProvider,
    model: String,
    local_base_url: String,
    explain_instructions: String,
    anthropic_key_configured: bool,
    local_key_configured: bool,
    open_router_key_configured: bool,
    session_sharing_mode: SessionSharingMode,
    paired_devices: Vec<PairedDevice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopAppearanceSettings {
    appearance: DesktopAppearance,
}

impl DesktopSettings {
    pub(crate) fn new(settings: &DesktopSettingsFile, secrets: &ExplainSecrets) -> Self {
        Self {
            appearance: settings.appearance,
            provider: settings.provider,
            model: settings.model.clone(),
            local_base_url: settings.local_base_url.clone(),
            explain_instructions: settings.explain_instructions.clone(),
            anthropic_key_configured: secrets.anthropic_api_key.is_some(),
            local_key_configured: secrets.local_api_key.is_some(),
            open_router_key_configured: secrets.open_router_api_key.is_some(),
            session_sharing_mode: settings.session_sharing_mode,
            paired_devices: settings.paired_devices.clone(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundLocalSecret {
    endpoint: String,
    api_key: String,
}

#[derive(Default)]
pub(crate) struct ExplainSecrets {
    pub(crate) anthropic_api_key: Option<String>,
    pub(crate) local_api_key: Option<String>,
    pub(crate) open_router_api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveDesktopSettingsRequest {
    appearance: DesktopAppearance,
    provider: ExplainProvider,
    model: String,
    local_base_url: String,
    explain_instructions: String,
    anthropic_api_key: String,
    local_api_key: String,
    open_router_api_key: String,
    clear_anthropic_api_key: bool,
    clear_local_api_key: bool,
    clear_open_router_api_key: bool,
    session_sharing_mode: SessionSharingMode,
    paired_devices: Vec<PairedDevice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSharingSettings {
    mode: SessionSharingMode,
    shared_session_keys: Vec<String>,
    has_configured_device: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSessionShareRequest {
    session_key: String,
    shared: bool,
}

fn default_explain_instructions() -> String {
    DEFAULT_EXPLAIN_INSTRUCTIONS.to_owned()
}

pub(crate) fn desktop_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
}

fn read_desktop_settings(path: &Path) -> Result<DesktopSettingsFile, String> {
    match fs::read(path) {
        Ok(contents) => {
            if contents.len() > MAX_SETTINGS_FILE_BYTES {
                return Err("Desktop settings file is too large".to_owned());
            }
            serde_json::from_slice(&contents).map_err(|error| error.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DesktopSettingsFile::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn validate_desktop_settings(settings: &mut DesktopSettingsFile) -> Result<(), String> {
    settings.model = settings.model.trim().to_owned();
    settings.local_base_url = settings
        .local_base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    settings.explain_instructions = settings.explain_instructions.trim().to_owned();
    validate_paired_devices(&mut settings.paired_devices)?;
    settings.shared_session_keys.sort();
    settings.shared_session_keys.dedup();
    if settings.shared_session_keys.len() > MAX_SHARED_SESSION_KEYS {
        return Err("Too many shared sessions are configured.".to_owned());
    }
    if settings
        .shared_session_keys
        .iter()
        .any(|key| !valid_session_key(key))
    {
        return Err("A shared session reference is invalid.".to_owned());
    }
    if settings.model.is_empty() {
        return Err("A model name is required.".to_owned());
    }
    if settings.model.len() > 256 {
        return Err("Model name is too long.".to_owned());
    }
    if settings.explain_instructions.is_empty() {
        return Err("Explain instructions are required.".to_owned());
    }
    if settings.explain_instructions.len() > MAX_EXPLAIN_INSTRUCTIONS_BYTES {
        return Err("Explain instructions are too long.".to_owned());
    }
    if settings.local_base_url.len() > 2048 {
        return Err("Local model endpoint is too long.".to_owned());
    }
    if settings.provider == ExplainProvider::OpenaiCompatible {
        let endpoint = reqwest::Url::parse(&settings.local_base_url)
            .map_err(|_| "Use a valid HTTP(S) model endpoint.".to_owned())?;
        let host = endpoint
            .host_str()
            .ok_or_else(|| "Use a valid HTTP(S) model endpoint.".to_owned())?;
        let loopback_host = host.trim_start_matches('[').trim_end_matches(']');
        let loopback = loopback_host.eq_ignore_ascii_case("localhost")
            || loopback_host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && loopback) {
            return Err("Use a valid HTTP(S) local model endpoint.".to_owned());
        }
        if !endpoint.username().is_empty() || endpoint.password().is_some() {
            return Err("Model endpoints cannot contain credentials.".to_owned());
        }
    }
    Ok(())
}

fn validate_paired_devices(devices: &mut [PairedDevice]) -> Result<(), String> {
    if devices.len() > MAX_PAIRED_DEVICES {
        return Err("Too many paired devices are configured.".to_owned());
    }
    for device in devices.iter_mut() {
        device.id = device.id.trim().to_owned();
        device.name = device.name.trim().to_owned();
        device.endpoint = device.endpoint.trim().to_owned();
        if device.id.is_empty()
            || device.id.len() > 128
            || !device
                .id
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
        {
            return Err("Each paired device needs a valid ID.".to_owned());
        }
        if device.name.is_empty() || device.name.len() > 128 {
            return Err("Each paired device needs a name.".to_owned());
        }
        if !valid_device_endpoint(&device.endpoint) {
            return Err("Each paired device needs a valid address.".to_owned());
        }
    }
    devices.sort_by(|left, right| left.id.cmp(&right.id));
    if devices.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err("Paired device IDs must be unique.".to_owned());
    }
    Ok(())
}

fn valid_device_endpoint(endpoint: &str) -> bool {
    if endpoint.is_empty() || endpoint.len() > 512 || endpoint.contains(char::is_whitespace) {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&format!("mesh://{endpoint}")) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let valid_host = host.parse::<std::net::IpAddr>().is_ok()
        || (host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .chars()
                        .all(|value| value.is_ascii_alphanumeric() || value == '-')
            }));
    valid_host
        && url.port().is_some_and(|port| port != 0)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
}

fn valid_session_key(key: &str) -> bool {
    key.len() <= 512
        && key.split_once(':').is_some_and(|(source, id)| {
            matches!(source, "codex" | "claude-code")
                && !id.is_empty()
                && id
                    .chars()
                    .all(|value| value.is_ascii_alphanumeric() || value == '-')
        })
}

fn validate_secret(secret: &str) -> Result<String, String> {
    let secret = secret.trim().to_owned();
    if secret.len() > MAX_SECRET_LENGTH {
        return Err("API key is too long.".to_owned());
    }
    Ok(secret)
}

fn read_bound_local_secret(store: &impl SecretStore) -> Result<Option<BoundLocalSecret>, String> {
    store
        .get(LOCAL_KEY_ACCOUNT)?
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "The local API key stored in Keychain is invalid.".to_owned())
        })
        .transpose()
}

fn read_explain_secrets(
    store: &impl SecretStore,
    local_base_url: &str,
) -> Result<ExplainSecrets, String> {
    let local = read_bound_local_secret(store)?
        .filter(|secret| secret.endpoint == local_base_url)
        .map(|secret| secret.api_key);
    Ok(ExplainSecrets {
        anthropic_api_key: store.get(ANTHROPIC_KEY_ACCOUNT)?,
        local_api_key: local,
        open_router_api_key: store.get(OPENROUTER_KEY_ACCOUNT)?,
    })
}

fn migrate_legacy_secrets(
    path: &Path,
    settings: &mut DesktopSettingsFile,
    store: &impl SecretStore,
) -> Result<(), String> {
    let legacy_anthropic = validate_secret(&settings.anthropic_api_key)?;
    let legacy_local = validate_secret(&settings.local_api_key)?;
    let legacy_openrouter = validate_secret(&settings.open_router_api_key)?;
    let has_legacy =
        !legacy_anthropic.is_empty() || !legacy_local.is_empty() || !legacy_openrouter.is_empty();
    if !legacy_anthropic.is_empty() {
        store.set(ANTHROPIC_KEY_ACCOUNT, &legacy_anthropic)?;
        if store.get(ANTHROPIC_KEY_ACCOUNT)?.as_deref() != Some(legacy_anthropic.as_str()) {
            return Err("Could not verify the migrated Anthropic API key.".to_owned());
        }
    }
    if !legacy_local.is_empty() {
        let bound = serde_json::to_string(&BoundLocalSecret {
            endpoint: settings.local_base_url.clone(),
            api_key: legacy_local,
        })
        .map_err(|error| error.to_string())?;
        store.set(LOCAL_KEY_ACCOUNT, &bound)?;
        if store.get(LOCAL_KEY_ACCOUNT)?.as_deref() != Some(bound.as_str()) {
            return Err("Could not verify the migrated local API key.".to_owned());
        }
    }
    if !legacy_openrouter.is_empty() {
        store.set(OPENROUTER_KEY_ACCOUNT, &legacy_openrouter)?;
        if store.get(OPENROUTER_KEY_ACCOUNT)?.as_deref() != Some(legacy_openrouter.as_str()) {
            return Err("Could not verify the migrated OpenRouter API key.".to_owned());
        }
    }
    settings.anthropic_api_key.clear();
    settings.local_api_key.clear();
    settings.open_router_api_key.clear();
    if has_legacy {
        write_desktop_settings(path, settings)?;
    }
    Ok(())
}

pub(crate) fn load_desktop_settings(
    path: &Path,
    store: &impl SecretStore,
) -> Result<(DesktopSettingsFile, ExplainSecrets), String> {
    let mut settings = read_desktop_settings(path)?;
    migrate_legacy_secrets(path, &mut settings, store)?;
    let secrets = read_explain_secrets(store, &settings.local_base_url)?;
    Ok((settings, secrets))
}

fn write_desktop_settings(path: &Path, settings: &DesktopSettingsFile) -> Result<(), String> {
    let parent = path.parent().ok_or("Desktop settings path is invalid")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SETTINGS_FILE_BYTES {
        return Err("Desktop settings file is too large".to_owned());
    }
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_desktop_settings(app: tauri::AppHandle) -> Result<DesktopSettings, String> {
    let (settings, secrets) =
        load_desktop_settings(&desktop_settings_path(&app)?, &SystemSecretStore)?;
    Ok(DesktopSettings::new(&settings, &secrets))
}

/// Appearance lives in the regular settings file. Do not unlock Keychain just
/// to paint the first frame of the app after every debug rebuild.
#[tauri::command]
pub(crate) fn get_desktop_appearance(
    app: tauri::AppHandle,
) -> Result<DesktopAppearanceSettings, String> {
    let settings = read_desktop_settings(&desktop_settings_path(&app)?)?;
    Ok(DesktopAppearanceSettings {
        appearance: settings.appearance,
    })
}

#[tauri::command]
pub(crate) fn save_desktop_settings(
    app: tauri::AppHandle,
    request: SaveDesktopSettingsRequest,
) -> Result<DesktopSettings, String> {
    let path = desktop_settings_path(&app)?;
    save_desktop_settings_with_store(&path, request, &SystemSecretStore)
}

fn save_desktop_settings_with_store(
    path: &Path,
    request: SaveDesktopSettingsRequest,
    store: &impl SecretStore,
) -> Result<DesktopSettings, String> {
    let (mut settings, _) = load_desktop_settings(path, store)?;
    let previous_local_base_url = settings.local_base_url.clone();
    let previous_sharing_mode = settings.session_sharing_mode;
    let previous_paired_devices = settings.paired_devices.clone();
    settings.appearance = request.appearance;
    settings.provider = request.provider;
    settings.model = request.model;
    settings.local_base_url = request.local_base_url;
    settings.explain_instructions = request.explain_instructions;
    settings.session_sharing_mode = request.session_sharing_mode;
    settings.paired_devices = request.paired_devices;
    if settings.paired_devices.is_empty() {
        settings.session_sharing_mode = SessionSharingMode::Off;
    }
    if settings.session_sharing_mode != SessionSharingMode::Selected
        || previous_sharing_mode != SessionSharingMode::Selected
        || settings.paired_devices != previous_paired_devices
        || settings.paired_devices.is_empty()
    {
        settings.shared_session_keys.clear();
    }
    validate_desktop_settings(&mut settings)?;
    let anthropic_key = validate_secret(&request.anthropic_api_key)?;
    let local_key = validate_secret(&request.local_api_key)?;
    let openrouter_key = validate_secret(&request.open_router_api_key)?;
    let stored_local = read_bound_local_secret(store)?;
    if previous_local_base_url != settings.local_base_url
        && local_key.is_empty()
        && !request.clear_local_api_key
        && stored_local.is_some()
    {
        return Err(
            "The model endpoint changed. Re-enter the local API key or clear it before saving."
                .to_owned(),
        );
    }

    update_secret(
        store,
        ANTHROPIC_KEY_ACCOUNT,
        &anthropic_key,
        request.clear_anthropic_api_key,
    )?;
    if !local_key.is_empty() {
        let bound = serde_json::to_string(&BoundLocalSecret {
            endpoint: settings.local_base_url.clone(),
            api_key: local_key,
        })
        .map_err(|error| error.to_string())?;
        store.set(LOCAL_KEY_ACCOUNT, &bound)?;
    } else if request.clear_local_api_key {
        store.delete(LOCAL_KEY_ACCOUNT)?;
    }
    update_secret(
        store,
        OPENROUTER_KEY_ACCOUNT,
        &openrouter_key,
        request.clear_open_router_api_key,
    )?;
    write_desktop_settings(path, &settings)?;
    let secrets = read_explain_secrets(store, &settings.local_base_url)?;
    Ok(DesktopSettings::new(&settings, &secrets))
}

#[tauri::command]
pub(crate) fn get_session_sharing_settings(
    app: tauri::AppHandle,
) -> Result<SessionSharingSettings, String> {
    let settings = read_desktop_settings(&desktop_settings_path(&app)?)?;
    Ok(SessionSharingSettings {
        mode: settings.session_sharing_mode,
        shared_session_keys: settings.shared_session_keys,
        has_configured_device: !settings.paired_devices.is_empty(),
    })
}

#[tauri::command]
pub(crate) fn update_session_share(
    app: tauri::AppHandle,
    request: UpdateSessionShareRequest,
) -> Result<SessionSharingSettings, String> {
    if !valid_session_key(&request.session_key) {
        return Err("The session reference is invalid.".to_owned());
    }
    let path = desktop_settings_path(&app)?;
    let mut settings = read_desktop_settings(&path)?;
    if request.shared {
        if settings.session_sharing_mode != SessionSharingMode::Selected {
            return Err("Selected-session sharing is not enabled.".to_owned());
        }
        if settings.paired_devices.is_empty() {
            return Err("Configure a device before sharing a transcript.".to_owned());
        }
        if !local_session_key_exists(&request.session_key)? {
            return Err("The local session was not found.".to_owned());
        }
        settings.shared_session_keys.push(request.session_key);
    } else {
        settings
            .shared_session_keys
            .retain(|key| key != &request.session_key);
    }
    validate_desktop_settings(&mut settings)?;
    write_desktop_settings(&path, &settings)?;
    Ok(SessionSharingSettings {
        mode: settings.session_sharing_mode,
        shared_session_keys: settings.shared_session_keys,
        has_configured_device: !settings.paired_devices.is_empty(),
    })
}

fn update_secret(
    store: &impl SecretStore,
    account: &str,
    secret: &str,
    clear: bool,
) -> Result<(), String> {
    if !secret.is_empty() {
        store.set(account, secret)
    } else if clear {
        store.delete(account)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::LOCAL_KEY_ACCOUNT;
    use serde_json::Value;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct MemorySecretStore {
        values: RefCell<HashMap<String, String>>,
        fail_writes: Cell<bool>,
    }

    impl SecretStore for MemorySecretStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.values.borrow().get(account).cloned())
        }

        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if self.fail_writes.get() {
                return Err("simulated Keychain failure".to_owned());
            }
            self.values
                .borrow_mut()
                .insert(account.to_owned(), secret.to_owned());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-vis-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn save_settings_request(local_base_url: &str) -> SaveDesktopSettingsRequest {
        SaveDesktopSettingsRequest {
            appearance: DesktopAppearance::WarmDark,
            provider: ExplainProvider::OpenaiCompatible,
            model: "qwen3:8b".to_owned(),
            local_base_url: local_base_url.to_owned(),
            explain_instructions: DEFAULT_EXPLAIN_INSTRUCTIONS.to_owned(),
            anthropic_api_key: String::new(),
            local_api_key: String::new(),
            open_router_api_key: String::new(),
            clear_anthropic_api_key: false,
            clear_local_api_key: false,
            clear_open_router_api_key: false,
            session_sharing_mode: SessionSharingMode::Off,
            paired_devices: Vec::new(),
        }
    }

    #[test]
    fn desktop_settings_hide_secrets_and_preserve_configured_flags() {
        let settings = DesktopSettingsFile::default();
        let secrets = ExplainSecrets {
            anthropic_api_key: Some("secret".to_owned()),
            ..ExplainSecrets::default()
        };
        let public = DesktopSettings::new(&settings, &secrets);

        assert!(public.anthropic_key_configured);
        assert!(!public.local_key_configured);
        let value = serde_json::to_value(public).unwrap();
        assert!(value.get("anthropicApiKey").is_none());
        assert!(value.get("anthropicKeyConfigured").is_some());
        assert_eq!(
            value.get("explainInstructions").and_then(Value::as_str),
            Some(DEFAULT_EXPLAIN_INSTRUCTIONS)
        );
        assert_eq!(
            value.get("appearance").and_then(Value::as_str),
            Some("warm-dark")
        );
    }

    #[test]
    fn older_desktop_settings_receive_default_explain_instructions() {
        let settings: DesktopSettingsFile = serde_json::from_value(serde_json::json!({
            "provider": "anthropic",
            "model": "claude-haiku-4-5",
            "localBaseUrl": "http://127.0.0.1:11434/v1",
            "anthropicApiKey": "",
            "localApiKey": "",
            "openRouterApiKey": ""
        }))
        .unwrap();

        assert_eq!(settings.explain_instructions, DEFAULT_EXPLAIN_INSTRUCTIONS);
        assert_eq!(settings.appearance, DesktopAppearance::WarmDark);
    }

    #[test]
    fn validates_desktop_settings_provider_inputs() {
        let mut settings = DesktopSettingsFile {
            provider: ExplainProvider::OpenaiCompatible,
            model: "  qwen3:8b  ".to_owned(),
            local_base_url: "http://127.0.0.1:11434/v1/".to_owned(),
            ..DesktopSettingsFile::default()
        };
        validate_desktop_settings(&mut settings).unwrap();
        assert_eq!(settings.model, "qwen3:8b");
        assert_eq!(settings.local_base_url, "http://127.0.0.1:11434/v1");

        settings.local_base_url = "file:///tmp/model".to_owned();
        assert_eq!(
            validate_desktop_settings(&mut settings).unwrap_err(),
            "Use a valid HTTP(S) model endpoint."
        );
        settings.local_base_url = "http://models.example.com/v1".to_owned();
        assert_eq!(
            validate_desktop_settings(&mut settings).unwrap_err(),
            "Use a valid HTTP(S) local model endpoint."
        );
        settings.local_base_url = "https://models.example.com/v1".to_owned();
        validate_desktop_settings(&mut settings).unwrap();
        settings.local_base_url = "http://[::1]:11434/v1".to_owned();
        validate_desktop_settings(&mut settings).unwrap();
    }

    #[test]
    fn validates_session_sharing_devices_and_references() {
        let mut settings = DesktopSettingsFile {
            paired_devices: vec![PairedDevice {
                id: "macbook-air".to_owned(),
                name: "MacBook Air".to_owned(),
                endpoint: "100.64.0.12:4242".to_owned(),
            }],
            shared_session_keys: vec![
                "codex:019fd3da-83a".to_owned(),
                "codex:019fd3da-83a".to_owned(),
            ],
            ..DesktopSettingsFile::default()
        };
        validate_desktop_settings(&mut settings).unwrap();
        assert_eq!(settings.shared_session_keys, ["codex:019fd3da-83a"]);

        settings.paired_devices[0].endpoint = "bad address".to_owned();
        assert_eq!(
            validate_desktop_settings(&mut settings).unwrap_err(),
            "Each paired device needs a valid address."
        );

        for invalid in [
            "example.com",
            "https://example.com:4242",
            "user@example.com:4242",
            "example.com:4242/path",
            "-bad.example:4242",
            "example.com:0",
        ] {
            settings.paired_devices[0].endpoint = invalid.to_owned();
            assert_eq!(
                validate_desktop_settings(&mut settings).unwrap_err(),
                "Each paired device needs a valid address."
            );
        }

        settings.paired_devices[0].endpoint = "device.tailnet.ts.net:4242".to_owned();
        validate_desktop_settings(&mut settings).unwrap();
        settings.paired_devices[0].endpoint = "[fd7a:115c:a1e0::1]:4242".to_owned();
        validate_desktop_settings(&mut settings).unwrap();
    }

    #[test]
    fn disabling_selected_sharing_clears_saved_session_access() {
        let directory = temp_dir("sharing-policy");
        let path = directory.join(SETTINGS_FILE);
        let settings = DesktopSettingsFile {
            session_sharing_mode: SessionSharingMode::Selected,
            shared_session_keys: vec!["codex:private-session".to_owned()],
            paired_devices: vec![PairedDevice {
                id: "phone".to_owned(),
                name: "Phone".to_owned(),
                endpoint: "100.64.0.12:4242".to_owned(),
            }],
            ..DesktopSettingsFile::default()
        };
        write_desktop_settings(&path, &settings).unwrap();

        save_desktop_settings_with_store(
            &path,
            save_settings_request("http://127.0.0.1:11434/v1"),
            &MemorySecretStore::default(),
        )
        .unwrap();

        let saved = read_desktop_settings(&path).unwrap();
        assert_eq!(saved.session_sharing_mode, SessionSharingMode::Off);
        assert!(saved.shared_session_keys.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn removing_the_last_device_disables_all_session_sharing() {
        let directory = temp_dir("sharing-device-removal");
        let path = directory.join(SETTINGS_FILE);
        let settings = DesktopSettingsFile {
            session_sharing_mode: SessionSharingMode::All,
            paired_devices: vec![PairedDevice {
                id: "phone".to_owned(),
                name: "Phone".to_owned(),
                endpoint: "100.64.0.12:4242".to_owned(),
            }],
            ..DesktopSettingsFile::default()
        };
        write_desktop_settings(&path, &settings).unwrap();
        let mut request = save_settings_request("http://127.0.0.1:11434/v1");
        request.session_sharing_mode = SessionSharingMode::All;

        let saved = save_desktop_settings_with_store(&path, request, &MemorySecretStore::default())
            .unwrap();

        assert_eq!(saved.session_sharing_mode, SessionSharingMode::Off);
        assert_eq!(
            read_desktop_settings(&path).unwrap().session_sharing_mode,
            SessionSharingMode::Off
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_settings_round_trip_with_private_permissions() {
        let directory = temp_dir("settings");
        let path = directory.join(SETTINGS_FILE);
        let settings = DesktopSettingsFile {
            provider: ExplainProvider::Openrouter,
            model: "google/gemini-2.5-flash-lite".to_owned(),
            open_router_api_key: "secret".to_owned(),
            ..DesktopSettingsFile::default()
        };

        write_desktop_settings(&path, &settings).unwrap();
        let loaded = read_desktop_settings(&path).unwrap();
        assert_eq!(loaded.provider, ExplainProvider::Openrouter);
        assert!(loaded.open_router_api_key.is_empty());
        let json = fs::read_to_string(&path).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("ApiKey"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migrates_plaintext_api_keys_before_sanitizing_settings() {
        let directory = temp_dir("settings-migration");
        let path = directory.join(SETTINGS_FILE);
        fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "provider": "openai-compatible",
                "model": "qwen3:8b",
                "localBaseUrl": "http://127.0.0.1:11434/v1",
                "anthropicApiKey": "anthropic-secret",
                "localApiKey": "local-secret",
                "openRouterApiKey": "openrouter-secret"
            }))
            .unwrap(),
        )
        .unwrap();
        let store = MemorySecretStore::default();

        let (_, secrets) = load_desktop_settings(&path, &store).unwrap();

        assert_eq!(
            secrets.anthropic_api_key.as_deref(),
            Some("anthropic-secret")
        );
        assert_eq!(secrets.local_api_key.as_deref(), Some("local-secret"));
        assert_eq!(
            secrets.open_router_api_key.as_deref(),
            Some("openrouter-secret")
        );
        let json = fs::read_to_string(&path).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("ApiKey"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_keychain_migration_keeps_plaintext_for_retry() {
        let directory = temp_dir("settings-migration-failure");
        let path = directory.join(SETTINGS_FILE);
        let legacy = serde_json::json!({
            "provider": "anthropic",
            "model": "claude-haiku-4-5",
            "localBaseUrl": "http://127.0.0.1:11434/v1",
            "anthropicApiKey": "still-recoverable"
        });
        fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
        let store = MemorySecretStore::default();
        store.fail_writes.set(true);

        assert!(load_desktop_settings(&path, &store).is_err());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("still-recoverable"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn changing_endpoint_requires_reentering_or_clearing_local_key() {
        let directory = temp_dir("endpoint-binding");
        let path = directory.join(SETTINGS_FILE);
        let store = MemorySecretStore::default();
        let mut first = save_settings_request("http://127.0.0.1:11434/v1");
        first.local_api_key = "local-secret".to_owned();
        save_desktop_settings_with_store(&path, first, &store).unwrap();

        let changed = save_settings_request("https://models.example.com/v1");
        assert_eq!(
            save_desktop_settings_with_store(&path, changed, &store).unwrap_err(),
            "The model endpoint changed. Re-enter the local API key or clear it before saving."
        );
        assert_eq!(
            read_desktop_settings(&path).unwrap().local_base_url,
            "http://127.0.0.1:11434/v1"
        );

        let mut reentered = save_settings_request("https://models.example.com/v1");
        reentered.local_api_key = "new-local-secret".to_owned();
        let public = save_desktop_settings_with_store(&path, reentered, &store).unwrap();
        assert!(public.local_key_configured);
        let secrets = read_explain_secrets(&store, "https://models.example.com/v1").unwrap();
        assert_eq!(secrets.local_api_key.as_deref(), Some("new-local-secret"));

        let mut cleared = save_settings_request("https://other.example.com/v1");
        cleared.clear_local_api_key = true;
        let public = save_desktop_settings_with_store(&path, cleared, &store).unwrap();
        assert!(!public.local_key_configured);
        assert!(store.get(LOCAL_KEY_ACCOUNT).unwrap().is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
