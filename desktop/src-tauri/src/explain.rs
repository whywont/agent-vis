use crate::secrets::SystemSecretStore;
use crate::settings::{
    desktop_settings_path, load_desktop_settings, validate_desktop_settings, DesktopSettingsFile,
    ExplainProvider, ExplainSecrets,
};
use crate::workspace::MAX_EDIT_FILE_BYTES;
use serde::Deserialize;
use std::time::Duration;

const MAX_EXPLAIN_PATH_BYTES: usize = 4 * 1024;
pub(crate) const MAX_EXPLAIN_PATCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXPLAIN_CONTEXT_BYTES: usize = 32 * 1024;
const MAX_EXPLAIN_FILE_BYTES: usize = MAX_EDIT_FILE_BYTES as usize;
const MAX_EXPLAIN_RESPONSE_BYTES: usize = 1024 * 1024;
const MISSING_EXPLAIN_API_KEY: &str =
    "Add an API key in Settings for the selected explanation provider.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExplainDiffRequest {
    pub(crate) filepath: String,
    pub(crate) patch: String,
    pub(crate) context_text: Option<String>,
    pub(crate) file_content: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiCompatibleResponse {
    pub(crate) choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiChoice {
    pub(crate) message: OpenAiMessage,
}

#[derive(Deserialize)]
pub(crate) struct OpenAiMessage {
    pub(crate) content: String,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicResponse {
    pub(crate) content: Vec<AnthropicContent>,
}

#[derive(Deserialize)]
pub(crate) struct AnthropicContent {
    #[serde(rename = "type")]
    pub(crate) content_type: String,
    pub(crate) text: Option<String>,
}

pub(crate) fn validate_explain_request(request: &mut ExplainDiffRequest) -> Result<(), String> {
    request.filepath = request.filepath.trim().to_owned();
    request.patch = request.patch.trim().to_owned();
    request.context_text = request
        .context_text
        .take()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    request.file_content = request
        .file_content
        .take()
        .map(|value| value.trim_end().to_owned())
        .filter(|value| !value.is_empty());
    if request.filepath.is_empty() || request.filepath.len() > MAX_EXPLAIN_PATH_BYTES {
        return Err("Use a valid file path for the explanation.".to_owned());
    }
    if request.patch.is_empty() {
        return Err("No patch content".to_owned());
    }
    if request.patch.len() > MAX_EXPLAIN_PATCH_BYTES {
        return Err("Patch is too large to explain.".to_owned());
    }
    if request
        .context_text
        .as_ref()
        .is_some_and(|value| value.len() > MAX_EXPLAIN_CONTEXT_BYTES)
    {
        return Err("Explanation context is too large.".to_owned());
    }
    if request
        .file_content
        .as_ref()
        .is_some_and(|value| value.len() > MAX_EXPLAIN_FILE_BYTES)
    {
        return Err("Explanation file context is too large.".to_owned());
    }
    Ok(())
}

pub(crate) fn explain_user_prompt(request: &ExplainDiffRequest) -> String {
    let context = request
        .context_text
        .as_ref()
        .map(|value| format!("User request that triggered this change:\n\"{value}\"\n\n"))
        .unwrap_or_default();
    let file_context = request
        .file_content
        .as_ref()
        .map(|value| format!("\n\nCurrent complete file for context:\n\n{value}"))
        .unwrap_or_default();
    format!(
        "{context}Explain this patch for {}:\n\n{}{file_context}",
        request.filepath, request.patch,
    )
}

fn explain_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .user_agent("agent-vis-desktop/0.1")
        .build()
        .map_err(|error| error.to_string())
}

pub(crate) fn required_explain_api_key(value: &str) -> Result<&str, String> {
    if value.is_empty() {
        Err(MISSING_EXPLAIN_API_KEY.to_owned())
    } else {
        Ok(value)
    }
}

async fn response_bytes_limited(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_EXPLAIN_RESPONSE_BYTES as u64)
    {
        return Err("Model response is too large.".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_EXPLAIN_RESPONSE_BYTES {
        return Err("Model response is too large.".to_owned());
    }
    Ok(bytes.to_vec())
}

async fn explain_openai_compatible(
    client: &reqwest::Client,
    settings: &DesktopSettingsFile,
    secrets: &ExplainSecrets,
    user_prompt: &str,
) -> Result<String, String> {
    let open_router = settings.provider == ExplainProvider::Openrouter;
    let base_url = if open_router {
        "https://openrouter.ai/api/v1"
    } else {
        settings.local_base_url.as_str()
    };
    let api_key = if open_router {
        secrets.open_router_api_key.as_deref().unwrap_or_default()
    } else {
        secrets.local_api_key.as_deref().unwrap_or_default()
    };
    if open_router {
        required_explain_api_key(api_key)?;
    }

    let mut request =
        client
            .post(format!("{base_url}/chat/completions"))
            .json(&serde_json::json!({
                "model": settings.model,
                "stream": false,
                "max_tokens": 512,
                "messages": [
                    { "role": "system", "content": settings.explain_instructions },
                    { "role": "user", "content": user_prompt }
                ]
            }));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    if open_router {
        request = request
            .header("HTTP-Referer", "https://agent-vis.local")
            .header("X-Title", "agent-vis");
    }
    let response = request.send().await.map_err(|error| {
        if open_router {
            format!("Could not reach OpenRouter: {error}")
        } else {
            format!("Could not reach local model: {error}")
        }
    })?;
    let status = response.status();
    let bytes = response_bytes_limited(response).await?;
    if !status.is_success() {
        return Err(format!(
            "Model request failed ({status}): {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let payload: OpenAiCompatibleResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "Model returned an invalid response.".to_owned())?;
    payload
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Model returned no explanation.".to_owned())
}

async fn explain_anthropic(
    client: &reqwest::Client,
    settings: &DesktopSettingsFile,
    secrets: &ExplainSecrets,
    user_prompt: &str,
) -> Result<String, String> {
    let api_key =
        required_explain_api_key(secrets.anthropic_api_key.as_deref().unwrap_or_default())?;
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": settings.model,
            "max_tokens": 512,
            "system": settings.explain_instructions,
            "messages": [{ "role": "user", "content": user_prompt }]
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Anthropic: {error}"))?;
    let status = response.status();
    let bytes = response_bytes_limited(response).await?;
    if !status.is_success() {
        return Err(format!(
            "Anthropic request failed ({status}): {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let payload: AnthropicResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "Anthropic returned an invalid response.".to_owned())?;
    let explanation = payload
        .content
        .into_iter()
        .filter(|block| block.content_type == "text")
        .filter_map(|block| block.text)
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned();
    if explanation.is_empty() {
        Err("Anthropic returned no explanation.".to_owned())
    } else {
        Ok(explanation)
    }
}

#[tauri::command]
pub(crate) async fn explain_diff(
    app: tauri::AppHandle,
    mut request: ExplainDiffRequest,
) -> Result<String, String> {
    validate_explain_request(&mut request)?;
    let (mut settings, secrets) =
        load_desktop_settings(&desktop_settings_path(&app)?, &SystemSecretStore)?;
    validate_desktop_settings(&mut settings)?;
    let client = explain_http_client()?;
    let prompt = explain_user_prompt(&request);
    match settings.provider {
        ExplainProvider::Anthropic => {
            explain_anthropic(&client, &settings, &secrets, &prompt).await
        }
        ExplainProvider::OpenaiCompatible | ExplainProvider::Openrouter => {
            explain_openai_compatible(&client, &settings, &secrets, &prompt).await
        }
    }
}
