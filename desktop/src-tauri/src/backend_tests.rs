use crate::explain::{
    explain_user_prompt, required_explain_api_key, validate_explain_request, AnthropicResponse,
    ExplainDiffRequest, OpenAiCompatibleResponse, MAX_EXPLAIN_PATCH_BYTES,
};
use crate::secrets::{SecretStore, LOCAL_KEY_ACCOUNT};
use crate::sessions::{
    collect_claude, collect_codex, collect_trusted_workspace_roots, read_last_claude_timestamp,
    read_session_batch, resolve_session_ref, system_time_iso, SessionMeta,
};
use crate::settings::{
    load_desktop_settings, read_desktop_settings, read_explain_secrets,
    save_desktop_settings_with_store, validate_desktop_settings, write_desktop_settings,
    DesktopSettings, DesktopSettingsFile, ExplainProvider, ExplainSecrets,
    SaveDesktopSettingsRequest, DEFAULT_EXPLAIN_INSTRUCTIONS, SETTINGS_FILE,
};
use crate::workspace::{
    git_branch_for_workspace, resolve_workspace_file, save_workspace_file_with_roots,
    validate_workspace_root, SaveWorkspaceFileRequest,
};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

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

fn save_settings_request(local_base_url: &str) -> SaveDesktopSettingsRequest {
    SaveDesktopSettingsRequest {
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
    }
}

fn trusted_roots(root: &Path) -> HashSet<PathBuf> {
    HashSet::from([root.canonicalize().unwrap()])
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("agent-vis-{name}-{nonce}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn converts_unix_epoch_to_iso_timestamp() {
    assert_eq!(
        system_time_iso(SystemTime::UNIX_EPOCH),
        "1970-01-01T00:00:00.000Z"
    );
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

#[test]
fn validates_and_builds_explain_prompts() {
    let mut request = ExplainDiffRequest {
        filepath: "  src/App.tsx  ".to_owned(),
        patch: "  *** Update File: src/App.tsx\n+const value = 1;  ".to_owned(),
        context_text: Some("  add the value  ".to_owned()),
        file_content: Some("const value = 1;\n".to_owned()),
    };

    validate_explain_request(&mut request).unwrap();
    assert_eq!(request.filepath, "src/App.tsx");
    assert_eq!(request.context_text.as_deref(), Some("add the value"));
    assert_eq!(
            explain_user_prompt(&request),
            "User request that triggered this change:\n\"add the value\"\n\nExplain this patch for src/App.tsx:\n\n*** Update File: src/App.tsx\n+const value = 1;\n\nCurrent complete file for context:\n\nconst value = 1;"
        );
}

#[test]
fn rejects_empty_or_oversized_explain_requests() {
    let mut empty = ExplainDiffRequest {
        filepath: "src/App.tsx".to_owned(),
        patch: "   ".to_owned(),
        context_text: None,
        file_content: None,
    };
    assert_eq!(
        validate_explain_request(&mut empty).unwrap_err(),
        "No patch content"
    );

    let mut oversized = ExplainDiffRequest {
        filepath: "src/App.tsx".to_owned(),
        patch: "x".repeat(MAX_EXPLAIN_PATCH_BYTES + 1),
        context_text: None,
        file_content: None,
    };
    assert_eq!(
        validate_explain_request(&mut oversized).unwrap_err(),
        "Patch is too large to explain."
    );
}

#[test]
fn provider_response_shapes_extract_text() {
    let openai: OpenAiCompatibleResponse = serde_json::from_value(serde_json::json!({
        "choices": [{ "message": { "content": "OpenAI explanation" } }]
    }))
    .unwrap();
    assert_eq!(openai.choices[0].message.content, "OpenAI explanation");

    let anthropic: AnthropicResponse = serde_json::from_value(serde_json::json!({
        "content": [{ "type": "text", "text": "Anthropic explanation" }]
    }))
    .unwrap();
    assert_eq!(
        anthropic.content[0].text.as_deref(),
        Some("Anthropic explanation")
    );
}

#[test]
fn missing_explain_keys_use_provider_agnostic_copy() {
    assert_eq!(
        required_explain_api_key("").unwrap_err(),
        "Add an API key in Settings for the selected explanation provider."
    );
    assert_eq!(required_explain_api_key("secret").unwrap(), "secret");
}

#[test]
fn workspace_file_reads_and_compare_before_write_saves() {
    let root = temp_dir("workspace-edit");
    let nested = root.join("src");
    fs::create_dir_all(&nested).unwrap();
    let path = nested.join("app.ts");
    fs::write(&path, "const value = 1;\n").unwrap();

    let roots = trusted_roots(&root);
    let resolved = resolve_workspace_file(root.to_str().unwrap(), "src/app.ts", &roots).unwrap();
    assert_eq!(resolved, path.canonicalize().unwrap());
    let saved = save_workspace_file_with_roots(
        SaveWorkspaceFileRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            filepath: "src/app.ts".to_owned(),
            expected_content: "const value = 1;\n".to_owned(),
            content: "const value = 2;\n".to_owned(),
        },
        &roots,
    )
    .unwrap();
    assert_eq!(saved.content, "const value = 2;\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), "const value = 2;\n");

    let error = save_workspace_file_with_roots(
        SaveWorkspaceFileRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            filepath: "src/app.ts".to_owned(),
            expected_content: "const value = 1;\n".to_owned(),
            content: "const value = 3;\n".to_owned(),
        },
        &roots,
    )
    .unwrap_err();
    assert_eq!(
        error,
        "File changed on disk. Reopen it before saving your edits."
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reads_the_current_workspace_git_branch() {
    let root = temp_dir("git-branch");
    let initialized = Command::new("git")
        .args(["init", "-b", "desktop-test-branch"])
        .current_dir(&root)
        .status()
        .unwrap();
    assert!(initialized.success());
    let roots = trusted_roots(&root);
    assert_eq!(
        git_branch_for_workspace(root.to_str().unwrap(), &roots).unwrap(),
        Some("desktop-test-branch".to_owned())
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_file_rejects_parent_and_symlink_escapes() {
    let root = temp_dir("workspace-boundary");
    let outside = temp_dir("workspace-outside");
    fs::write(outside.join("secret.txt"), "secret").unwrap();
    let roots = trusted_roots(&root);

    assert_eq!(
        resolve_workspace_file(root.to_str().unwrap(), "../secret.txt", &roots).unwrap_err(),
        "File path escapes the session workspace."
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(outside.join("secret.txt"), root.join("linked.txt")).unwrap();
        assert_eq!(
            resolve_workspace_file(root.to_str().unwrap(), "linked.txt", &roots).unwrap_err(),
            "File path escapes the session workspace."
        );
    }
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn workspace_root_requires_a_trusted_session_cwd() {
    let root = temp_dir("workspace-authorized");
    let untrusted = temp_dir("workspace-untrusted");
    let roots = trusted_roots(&root);

    assert_eq!(
        validate_workspace_root(untrusted.to_str().unwrap(), &roots).unwrap_err(),
        "Session workspace is not authorized."
    );
    assert_eq!(
        validate_workspace_root(root.to_str().unwrap(), &roots).unwrap(),
        root.canonicalize().unwrap()
    );
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(untrusted).unwrap();
}

#[test]
fn trusted_workspace_roots_come_from_session_cwds() {
    let root = temp_dir("workspace-session-cwd");
    let sessions = vec![SessionMeta {
        file: "session.jsonl".to_owned(),
        files: vec!["session.jsonl".to_owned()],
        id: "session".to_owned(),
        cwd: root.to_string_lossy().into_owned(),
        model: String::new(),
        timestamp: String::new(),
        modified: String::new(),
        cli_version: String::new(),
        source: "codex",
        project: None,
    }];

    assert_eq!(
        collect_trusted_workspace_roots(&sessions),
        trusted_roots(&root)
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn filesystem_root_is_never_an_authorized_workspace() {
    let roots = HashSet::from([PathBuf::from("/")]);
    assert_eq!(
        validate_workspace_root("/", &roots).unwrap_err(),
        "The filesystem root cannot be used as a session workspace."
    );
}

#[test]
fn ignores_timestampless_claude_bookkeeping_records() {
    let dir = temp_dir("timestamp");
    let path = dir.join("session.jsonl");
    let mut file = File::create(&path).unwrap();
    writeln!(
        file,
        r#"{{"type":"user","timestamp":"2026-07-29T20:00:00.000Z"}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"type":"assistant","timestamp":"2026-07-29T20:05:00.000Z"}}"#
    )
    .unwrap();
    writeln!(file, r#"{{"type":"last-prompt","lastPrompt":"hello"}}"#).unwrap();

    assert_eq!(
        read_last_claude_timestamp(&path).as_deref(),
        Some("2026-07-29T20:05:00.000Z")
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lists_parent_sessions_without_promoting_subagents() {
    let root = temp_dir("claude-scan");
    let project = root.join("-Users-alice-project");
    let subagents = project.join("subagents");
    fs::create_dir_all(&subagents).unwrap();

    fs::write(
        project.join("parent.jsonl"),
        concat!(
            "{\"type\":\"user\",\"sessionId\":\"parent\",",
            "\"cwd\":\"/Users/alice/project\",",
            "\"timestamp\":\"2026-07-29T20:00:00.000Z\"}\n"
        ),
    )
    .unwrap();
    fs::write(
        subagents.join("agent-child.jsonl"),
        concat!(
            "{\"type\":\"user\",\"sessionId\":\"child\",",
            "\"cwd\":\"/Users/alice/project\",",
            "\"timestamp\":\"2026-07-29T20:01:00.000Z\"}\n"
        ),
    )
    .unwrap();

    let mut sessions = Vec::new();
    collect_claude(&root, &mut sessions);

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "parent");
    assert_eq!(sessions[0].files, vec![sessions[0].file.clone()]);
    assert_eq!(sessions[0].project.as_deref(), Some("project"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_session_uses_top_level_metadata_timestamp() {
    let root = temp_dir("codex-top-level-timestamp");
    let path = root.join("session.jsonl");
    fs::write(
        &path,
        concat!(
            "{\"type\":\"session_meta\",",
            "\"timestamp\":\"2026-08-02T00:00:00Z\",",
            "\"payload\":{\"id\":\"session\",\"cwd\":\"/repo\"}}\n"
        ),
    )
    .unwrap();

    let mut sessions = Vec::new();
    collect_codex(&root, &root, &mut sessions);

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].timestamp, "2026-08-02T00:00:00Z");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn session_discovery_ignores_symlinked_files_and_directories() {
    use std::os::unix::fs::symlink;

    let root = temp_dir("discovery-symlinks");
    let codex_root = root.join("codex");
    let outside = root.join("outside");
    fs::create_dir_all(&codex_root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        outside.join("outside.jsonl"),
        concat!(
            "{\"type\":\"session_meta\",\"payload\":{",
            "\"id\":\"outside\",\"cwd\":\"/private\"}}\n"
        ),
    )
    .unwrap();
    symlink(outside.join("outside.jsonl"), codex_root.join("file.jsonl")).unwrap();
    symlink(&outside, codex_root.join("directory")).unwrap();

    let mut sessions = Vec::new();
    collect_codex(&codex_root, &codex_root, &mut sessions);
    assert!(sessions.is_empty());

    let claude_root = root.join("claude");
    let real_project = root.join("-Users-alice-private");
    fs::create_dir_all(&claude_root).unwrap();
    fs::create_dir_all(&real_project).unwrap();
    fs::write(
        real_project.join("outside.jsonl"),
        concat!(
            "{\"type\":\"user\",\"sessionId\":\"outside\",",
            "\"cwd\":\"/private\",\"timestamp\":\"2026-08-02T00:00:00Z\"}\n"
        ),
    )
    .unwrap();
    symlink(&real_project, claude_root.join("-Users-alice-private")).unwrap();

    collect_claude(&claude_root, &mut sessions);
    assert!(sessions.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_session_paths_outside_the_known_roots() {
    let home = temp_dir("path-safety");
    fs::create_dir_all(home.join(".codex/sessions")).unwrap();
    assert!(resolve_session_ref(&home, "../../.ssh/id_rsa.jsonl").is_err());
    assert!(resolve_session_ref(&home, "/tmp/session.jsonl").is_err());
    fs::remove_dir_all(home).unwrap();
}

fn read_all_batches(path: &Path, source: &'static str, target_bytes: usize) -> Vec<String> {
    let mut offset = 0;
    let mut all = Vec::new();
    loop {
        let mut remaining = target_bytes;
        let (batch, next_offset, done) =
            read_session_batch(path, source, "session.jsonl", offset, &mut remaining).unwrap();
        all.extend(batch.lines);
        if done {
            break;
        }
        assert!(next_offset > offset);
        offset = next_offset;
    }
    all
}

#[test]
fn batching_reassembles_every_jsonl_record_exactly() {
    let dir = temp_dir("lossless-batches");
    let path = dir.join("session.jsonl");
    let expected = vec![
        r#"{"type":"event_msg","payload":{"message":"first"}}"#.to_owned(),
        r#"{"type":"response_item","payload":{"output":"second"}}"#.to_owned(),
        r#"{"type":"event_msg","payload":{"message":"third"}}"#.to_owned(),
    ];
    fs::write(&path, expected.join("\n") + "\n").unwrap();
    assert_eq!(read_all_batches(&path, "codex", 40), expected);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_record_larger_than_the_batch_target_is_returned_whole() {
    let dir = temp_dir("large-lossless-record");
    let path = dir.join("session.jsonl");
    let large = serde_json::json!({
        "type": "response_item",
        "payload": {
            "call_id": "large-call",
            "output": "x".repeat(2 * 1024 * 1024)
        }
    })
    .to_string();
    fs::write(&path, &large).unwrap();
    assert_eq!(read_all_batches(&path, "codex", 64 * 1024), vec![large]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn batching_preserves_unicode_and_the_final_record_without_newline() {
    let dir = temp_dir("unicode-batches");
    let path = dir.join("session.jsonl");
    let expected = vec![
        r#"{"message":"hello 👋"}"#.to_owned(),
        r#"{"message":"最後の記録"}"#.to_owned(),
    ];
    fs::write(&path, expected.join("\n")).unwrap();
    assert_eq!(read_all_batches(&path, "claude-code", 10), expected);
    fs::remove_dir_all(dir).unwrap();
}
