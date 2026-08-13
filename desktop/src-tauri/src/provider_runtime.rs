use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::shell_environment::apply_desktop_shell_environment;
use crate::sleep_inhibitor::AgentTurnSleepInhibitor;
use crate::{
    claude_stream::{
        connect_claude_thread, send_claude_turn, start_claude_session, ClaudeStreamState,
        ClaudeThreadRequest, ClaudeTurnRequest, NewClaudeSessionRequest,
    },
    codex_app_server::{
        connect_codex_thread, send_codex_turn, start_codex_session, CodexAppServerState,
        CodexThreadRequest, CodexTurnRequest, NewCodexSessionRequest,
    },
};

const PROVIDER_INVENTORY_EVENT: &str = "agent-provider-inventory-updated";
const PROVIDER_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PROBE_DETAIL_CHARS: usize = 500;
const MAX_RUNTIME_EVENT_STREAMS: usize = 64;
const MAX_RUNTIME_REPLAY_EVENTS: usize = 4_096;
const MAX_RUNTIME_REPLAY_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PROVIDER_RUNTIME_EVENT: &str = "agent-provider-runtime-event";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderRuntimeOperation {
    StartSession,
    ResumeSession,
    SendTurn,
    InterruptTurn,
    RespondToApproval,
    RespondToUserInput,
    StopSession,
    ListSessions,
    ReadThread,
    RollbackThread,
    ChangeModel,
}

const COMPLETE_RUNTIME_OPERATIONS: [ProviderRuntimeOperation; 11] = [
    ProviderRuntimeOperation::StartSession,
    ProviderRuntimeOperation::ResumeSession,
    ProviderRuntimeOperation::SendTurn,
    ProviderRuntimeOperation::InterruptTurn,
    ProviderRuntimeOperation::RespondToApproval,
    ProviderRuntimeOperation::RespondToUserInput,
    ProviderRuntimeOperation::StopSession,
    ProviderRuntimeOperation::ListSessions,
    ProviderRuntimeOperation::ReadThread,
    ProviderRuntimeOperation::RollbackThread,
    ProviderRuntimeOperation::ChangeModel,
];

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderTransport {
    CodexAppServer,
    ClaudeStreamJson,
    AgentClientProtocol,
    OpenCodeServer,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderDiscoveryMethod {
    AppServer,
    CliAndInit,
    CliAndAcp,
    CliAndHttp,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderInventoryCoverage {
    method: ProviderDiscoveryMethod,
    version: bool,
    authentication: bool,
    models: bool,
    slash_commands: bool,
    skills: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProviderDriver {
    instance_id: String,
    driver: String,
    display_name: String,
    executable: String,
    transport: ProviderTransport,
    supports_multiple_instances: bool,
    runtime_available: bool,
    required_operations: Vec<ProviderRuntimeOperation>,
    inventory: ProviderInventoryCoverage,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderInventoryStatus {
    Checking,
    Ready,
    Warning,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProviderSnapshot {
    instance_id: String,
    status: ProviderInventoryStatus,
    installed: Option<bool>,
    version: Option<String>,
    detail: Option<String>,
    checked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProviderRuntimeEvent {
    provider_instance_id: String,
    session_key: String,
    sequence: u64,
    message: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadAgentProviderRuntimeEventsRequest {
    provider_instance_id: String,
    session_key: String,
    after_sequence: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProviderRuntimeReplay {
    events: Vec<AgentProviderRuntimeEvent>,
    oldest_available_sequence: u64,
    latest_sequence: u64,
    reset_required: bool,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct RuntimeEventStreamKey {
    provider_instance_id: String,
    session_key: String,
}

#[derive(Default)]
struct RuntimeEventBuffer {
    next_sequence: u64,
    retained_bytes: usize,
    last_touched: u64,
    events: VecDeque<(usize, AgentProviderRuntimeEvent)>,
}

#[derive(Default)]
struct RuntimeEventStore {
    touch_counter: u64,
    streams: HashMap<RuntimeEventStreamKey, RuntimeEventBuffer>,
}

impl RuntimeEventStore {
    fn record(
        &mut self,
        provider_instance_id: &str,
        session_key: &str,
        message: &Value,
    ) -> AgentProviderRuntimeEvent {
        self.record_with_limits(
            provider_instance_id,
            session_key,
            message,
            MAX_RUNTIME_EVENT_STREAMS,
            MAX_RUNTIME_REPLAY_EVENTS,
            MAX_RUNTIME_REPLAY_BYTES,
        )
    }

    fn record_with_limits(
        &mut self,
        provider_instance_id: &str,
        session_key: &str,
        message: &Value,
        max_streams: usize,
        max_events: usize,
        max_bytes: usize,
    ) -> AgentProviderRuntimeEvent {
        let key = RuntimeEventStreamKey {
            provider_instance_id: provider_instance_id.to_owned(),
            session_key: session_key.to_owned(),
        };
        if !self.streams.contains_key(&key) && self.streams.len() >= max_streams {
            if let Some(oldest) = self
                .streams
                .iter()
                .min_by_key(|(_, buffer)| buffer.last_touched)
                .map(|(key, _)| key.clone())
            {
                self.streams.remove(&oldest);
            }
        }

        self.touch_counter = self.touch_counter.saturating_add(1);
        let buffer = self.streams.entry(key).or_default();
        buffer.last_touched = self.touch_counter;
        buffer.next_sequence = buffer.next_sequence.saturating_add(1).max(1);
        let event = AgentProviderRuntimeEvent {
            provider_instance_id: provider_instance_id.to_owned(),
            session_key: session_key.to_owned(),
            sequence: buffer.next_sequence,
            message: message.clone(),
        };
        let event_bytes = serde_json::to_vec(&event).map_or(0, |encoded| encoded.len());
        buffer.retained_bytes = buffer.retained_bytes.saturating_add(event_bytes);
        buffer.events.push_back((event_bytes, event.clone()));
        while buffer.events.len() > max_events || buffer.retained_bytes > max_bytes {
            let Some((removed_bytes, _)) = buffer.events.pop_front() else {
                break;
            };
            buffer.retained_bytes = buffer.retained_bytes.saturating_sub(removed_bytes);
        }
        event
    }

    fn replay(
        &self,
        provider_instance_id: &str,
        session_key: &str,
        after_sequence: Option<u64>,
    ) -> AgentProviderRuntimeReplay {
        let key = RuntimeEventStreamKey {
            provider_instance_id: provider_instance_id.to_owned(),
            session_key: session_key.to_owned(),
        };
        let Some(buffer) = self.streams.get(&key) else {
            return AgentProviderRuntimeReplay {
                events: Vec::new(),
                oldest_available_sequence: 1,
                latest_sequence: 0,
                reset_required: after_sequence.is_some_and(|sequence| sequence > 0),
            };
        };
        let latest_sequence = buffer.next_sequence;
        let oldest_available_sequence = buffer
            .events
            .front()
            .map_or(latest_sequence.saturating_add(1), |(_, event)| {
                event.sequence
            });
        let reset_required = after_sequence.is_some_and(|sequence| {
            sequence > latest_sequence || sequence.saturating_add(1) < oldest_available_sequence
        });
        let events = buffer
            .events
            .iter()
            .filter(|(_, event)| after_sequence.is_none_or(|sequence| event.sequence > sequence))
            .map(|(_, event)| event.clone())
            .collect();
        AgentProviderRuntimeReplay {
            events,
            oldest_available_sequence,
            latest_sequence,
            reset_required,
        }
    }
}

pub(crate) fn emit_provider_runtime_event(
    app: &AppHandle,
    provider_instance_id: &str,
    session_key: &str,
    message: &Value,
) {
    let Some(state) = app.try_state::<ProviderRuntimeState>() else {
        return;
    };
    let event = state.record_runtime_event(provider_instance_id, session_key, message);
    let _ = app.emit(PROVIDER_RUNTIME_EVENT, event);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartAgentProviderSessionRequest {
    provider_instance_id: String,
    session_key: String,
    thread_id: Option<String>,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedAgentProviderSession {
    provider_instance_id: String,
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumeAgentProviderSessionRequest {
    provider_instance_id: String,
    session_key: String,
    thread_id: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendAgentProviderTurnRequest {
    provider_instance_id: String,
    session_key: String,
    thread_id: String,
    turn_id: Option<String>,
    text: String,
    image_urls: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeProviderRuntime {
    Codex,
    Claude,
}

fn native_provider_runtime(instance_id: &str) -> Result<NativeProviderRuntime, String> {
    match instance_id {
        "codex" => Ok(NativeProviderRuntime::Codex),
        "claude-code" => Ok(NativeProviderRuntime::Claude),
        _ if built_in_provider_drivers()
            .iter()
            .any(|driver| driver.instance_id == instance_id) => Err(format!(
            "Provider instance {instance_id} is installed in the registry but its runtime adapter is not available yet."
        )),
        _ => Err(format!("Unknown provider instance: {instance_id}.")),
    }
}

impl AgentProviderSnapshot {
    fn checking(instance_id: String) -> Self {
        Self {
            instance_id,
            status: ProviderInventoryStatus::Checking,
            installed: None,
            version: None,
            detail: None,
            checked_at_ms: None,
        }
    }
}

pub(crate) struct ProviderRuntimeState {
    snapshots: Arc<Mutex<Vec<AgentProviderSnapshot>>>,
    refreshing: Arc<AtomicBool>,
    runtime_events: Mutex<RuntimeEventStore>,
    sleep_inhibitor: Mutex<AgentTurnSleepInhibitor>,
}

impl ProviderRuntimeState {
    pub(crate) fn new() -> Self {
        let snapshots = built_in_provider_drivers()
            .into_iter()
            .map(|driver| AgentProviderSnapshot::checking(driver.instance_id))
            .collect();
        Self {
            snapshots: Arc::new(Mutex::new(snapshots)),
            refreshing: Arc::new(AtomicBool::new(false)),
            runtime_events: Mutex::new(RuntimeEventStore::default()),
            sleep_inhibitor: Mutex::new(AgentTurnSleepInhibitor::new()),
        }
    }

    pub(crate) fn start_background_inventory(&self, app: AppHandle) -> bool {
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }

        let drivers = built_in_provider_drivers();
        let snapshots = Arc::clone(&self.snapshots);
        let refreshing = Arc::clone(&self.refreshing);
        thread::spawn(move || {
            let (sender, receiver) = mpsc::channel();
            thread::scope(|scope| {
                for driver in drivers {
                    let sender = sender.clone();
                    scope.spawn(move || {
                        let _ = sender.send(probe_provider(&driver));
                    });
                }
                drop(sender);

                for snapshot in receiver {
                    let current = {
                        let mut current =
                            snapshots.lock().unwrap_or_else(|value| value.into_inner());
                        if let Some(existing) = current
                            .iter_mut()
                            .find(|entry| entry.instance_id == snapshot.instance_id)
                        {
                            *existing = snapshot;
                        }
                        current.clone()
                    };
                    let _ = app.emit(PROVIDER_INVENTORY_EVENT, current);
                }
            });
            refreshing.store(false, Ordering::Release);
        });
        true
    }

    fn snapshots(&self) -> Vec<AgentProviderSnapshot> {
        self.snapshots
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    }

    fn record_runtime_event(
        &self,
        provider_instance_id: &str,
        session_key: &str,
        message: &Value,
    ) -> AgentProviderRuntimeEvent {
        self.sleep_inhibitor
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .observe(provider_instance_id, session_key, message);
        self.runtime_events
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .record(provider_instance_id, session_key, message)
    }

    fn replay_runtime_events(
        &self,
        provider_instance_id: &str,
        session_key: &str,
        after_sequence: Option<u64>,
    ) -> AgentProviderRuntimeReplay {
        self.runtime_events
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .replay(provider_instance_id, session_key, after_sequence)
    }
}

fn driver(
    instance_id: &str,
    driver: &str,
    display_name: &str,
    executable: &str,
    transport: ProviderTransport,
    runtime_available: bool,
    inventory: ProviderInventoryCoverage,
) -> AgentProviderDriver {
    AgentProviderDriver {
        instance_id: instance_id.to_owned(),
        driver: driver.to_owned(),
        display_name: display_name.to_owned(),
        executable: executable.to_owned(),
        transport,
        supports_multiple_instances: true,
        runtime_available,
        required_operations: COMPLETE_RUNTIME_OPERATIONS.to_vec(),
        inventory,
    }
}

pub(crate) fn built_in_provider_drivers() -> Vec<AgentProviderDriver> {
    vec![
        driver(
            "codex",
            "codex",
            "Codex",
            "codex",
            ProviderTransport::CodexAppServer,
            true,
            ProviderInventoryCoverage {
                method: ProviderDiscoveryMethod::AppServer,
                version: true,
                authentication: true,
                models: true,
                slash_commands: false,
                skills: true,
            },
        ),
        driver(
            "claude-code",
            "claudeAgent",
            "Claude Code",
            "claude",
            ProviderTransport::ClaudeStreamJson,
            true,
            ProviderInventoryCoverage {
                method: ProviderDiscoveryMethod::CliAndInit,
                version: true,
                authentication: true,
                models: true,
                slash_commands: true,
                skills: false,
            },
        ),
        driver(
            "cursor",
            "cursor",
            "Cursor Agent",
            "cursor-agent",
            ProviderTransport::AgentClientProtocol,
            false,
            ProviderInventoryCoverage {
                method: ProviderDiscoveryMethod::CliAndAcp,
                version: true,
                authentication: true,
                models: true,
                slash_commands: false,
                skills: false,
            },
        ),
        driver(
            "grok",
            "grok",
            "Grok",
            "grok",
            ProviderTransport::AgentClientProtocol,
            false,
            ProviderInventoryCoverage {
                method: ProviderDiscoveryMethod::CliAndAcp,
                version: true,
                authentication: false,
                models: true,
                slash_commands: false,
                skills: false,
            },
        ),
        driver(
            "opencode",
            "opencode",
            "OpenCode",
            "opencode",
            ProviderTransport::OpenCodeServer,
            false,
            ProviderInventoryCoverage {
                method: ProviderDiscoveryMethod::CliAndHttp,
                version: true,
                authentication: true,
                models: true,
                slash_commands: false,
                skills: false,
            },
        ),
    ]
}

fn probe_arguments(driver: &AgentProviderDriver) -> &'static [&'static str] {
    match driver.driver.as_str() {
        "cursor" => &["about"],
        _ => &["--version"],
    }
}

fn probe_provider(driver: &AgentProviderDriver) -> AgentProviderSnapshot {
    let checked_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut command = Command::new(&driver.executable);
    apply_desktop_shell_environment(&mut command)
        .args(probe_arguments(driver))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return AgentProviderSnapshot {
                instance_id: driver.instance_id.clone(),
                status: ProviderInventoryStatus::Unavailable,
                installed: Some(false),
                version: None,
                detail: Some(format!("{} was not found on PATH.", driver.executable)),
                checked_at_ms: Some(checked_at_ms),
            };
        }
        Err(error) => {
            return AgentProviderSnapshot {
                instance_id: driver.instance_id.clone(),
                status: ProviderInventoryStatus::Warning,
                installed: None,
                version: None,
                detail: Some(compact_detail(&error.to_string())),
                checked_at_ms: Some(checked_at_ms),
            };
        }
    };

    let started = Instant::now();
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < PROVIDER_PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "{} did not respond within {} seconds.",
                    driver.executable,
                    PROVIDER_PROBE_TIMEOUT.as_secs()
                ));
            }
            Err(error) => break Err(error.to_string()),
        }
    };

    let status = match exit_status {
        Ok(status) => status,
        Err(detail) => {
            return AgentProviderSnapshot {
                instance_id: driver.instance_id.clone(),
                status: ProviderInventoryStatus::Warning,
                installed: Some(true),
                version: None,
                detail: Some(compact_detail(&detail)),
                checked_at_ms: Some(checked_at_ms),
            };
        }
    };

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return AgentProviderSnapshot {
                instance_id: driver.instance_id.clone(),
                status: ProviderInventoryStatus::Warning,
                installed: Some(true),
                version: None,
                detail: Some(compact_detail(&error.to_string())),
                checked_at_ms: Some(checked_at_ms),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let version = parse_cli_version(combined);
    let detail = (!combined.is_empty()).then(|| compact_detail(combined));

    AgentProviderSnapshot {
        instance_id: driver.instance_id.clone(),
        status: if status.success() {
            ProviderInventoryStatus::Ready
        } else {
            ProviderInventoryStatus::Warning
        },
        installed: Some(true),
        version,
        detail: if status.success() { None } else { detail },
        checked_at_ms: Some(checked_at_ms),
    }
}

fn parse_cli_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let candidate = word
            .trim_matches(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_'))
            })
            .trim_start_matches(['v', 'V']);
        let begins_with_digit = candidate
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit());
        (begins_with_digit && candidate.contains('.')).then(|| candidate.to_owned())
    })
}

fn compact_detail(detail: &str) -> String {
    let flattened = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    flattened.chars().take(MAX_PROBE_DETAIL_CHARS).collect()
}

#[tauri::command]
pub(crate) fn list_agent_provider_drivers() -> Vec<AgentProviderDriver> {
    built_in_provider_drivers()
}

#[tauri::command]
pub(crate) fn list_agent_provider_inventory(
    state: State<'_, ProviderRuntimeState>,
) -> Vec<AgentProviderSnapshot> {
    state.snapshots()
}

#[tauri::command]
pub(crate) fn refresh_agent_provider_inventory(
    app: AppHandle,
    state: State<'_, ProviderRuntimeState>,
) -> bool {
    state.start_background_inventory(app)
}

#[tauri::command]
pub(crate) fn read_agent_provider_runtime_events(
    state: State<'_, ProviderRuntimeState>,
    request: ReadAgentProviderRuntimeEventsRequest,
) -> Result<AgentProviderRuntimeReplay, String> {
    if native_provider_runtime(&request.provider_instance_id).is_err()
        || request.session_key.trim().is_empty()
        || request.session_key.len() > 512
    {
        return Err("A valid runtime provider instance and session key are required.".to_owned());
    }
    Ok(state.replay_runtime_events(
        &request.provider_instance_id,
        &request.session_key,
        request.after_sequence,
    ))
}

#[tauri::command]
pub(crate) fn start_agent_provider_session(
    app: AppHandle,
    codex_state: State<'_, CodexAppServerState>,
    claude_state: State<'_, ClaudeStreamState>,
    request: StartAgentProviderSessionRequest,
) -> Result<StartedAgentProviderSession, String> {
    let provider_instance_id = request.provider_instance_id.clone();
    let thread_id = match native_provider_runtime(&request.provider_instance_id)? {
        NativeProviderRuntime::Codex => {
            start_codex_session(
                app,
                codex_state,
                NewCodexSessionRequest {
                    session_key: request.session_key,
                    cwd: request.cwd,
                    model: request.model,
                    effort: request.effort,
                },
            )?
            .id
        }
        NativeProviderRuntime::Claude => {
            let thread_id = request
                .thread_id
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Claude Code requires a thread ID when starting a session.".to_owned()
                })?;
            start_claude_session(
                app,
                claude_state,
                NewClaudeSessionRequest {
                    session_key: request.session_key,
                    thread_id,
                    cwd: request.cwd,
                    model: request.model,
                    effort: request.effort,
                },
            )?
        }
    };
    Ok(StartedAgentProviderSession {
        provider_instance_id,
        thread_id,
    })
}

#[tauri::command]
pub(crate) fn resume_agent_provider_session(
    app: AppHandle,
    codex_state: State<'_, CodexAppServerState>,
    claude_state: State<'_, ClaudeStreamState>,
    request: ResumeAgentProviderSessionRequest,
) -> Result<(), String> {
    match native_provider_runtime(&request.provider_instance_id)? {
        NativeProviderRuntime::Codex => connect_codex_thread(
            app,
            codex_state,
            CodexThreadRequest {
                session_key: request.session_key,
                thread_id: request.thread_id,
                cwd: request.cwd,
            },
        ),
        NativeProviderRuntime::Claude => connect_claude_thread(
            app,
            claude_state,
            ClaudeThreadRequest {
                session_key: request.session_key,
                thread_id: request.thread_id,
                cwd: request.cwd,
            },
        ),
    }
}

#[tauri::command]
pub(crate) fn send_agent_provider_turn(
    app: AppHandle,
    codex_state: State<'_, CodexAppServerState>,
    claude_state: State<'_, ClaudeStreamState>,
    request: SendAgentProviderTurnRequest,
) -> Result<(), String> {
    match native_provider_runtime(&request.provider_instance_id)? {
        NativeProviderRuntime::Codex => send_codex_turn(
            app,
            codex_state,
            CodexTurnRequest {
                session_key: request.session_key,
                thread_id: request.thread_id,
                turn_id: request.turn_id,
                text: request.text,
                image_urls: request.image_urls,
            },
        ),
        NativeProviderRuntime::Claude => send_claude_turn(
            claude_state,
            ClaudeTurnRequest {
                session_key: request.session_key,
                text: request.text,
                image_urls: request.image_urls,
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_covers_every_t3_builtin_driver() {
        let drivers = built_in_provider_drivers();
        assert_eq!(drivers.len(), 5);
        assert_eq!(
            drivers
                .iter()
                .map(|driver| driver.driver.as_str())
                .collect::<Vec<_>>(),
            ["codex", "claudeAgent", "cursor", "grok", "opencode"]
        );
    }

    #[test]
    fn every_driver_implements_the_complete_runtime_contract() {
        let expected = COMPLETE_RUNTIME_OPERATIONS
            .into_iter()
            .collect::<HashSet<_>>();
        for driver in built_in_provider_drivers() {
            assert_eq!(
                driver
                    .required_operations
                    .iter()
                    .copied()
                    .collect::<HashSet<_>>(),
                expected,
                "{} should expose the complete runtime contract",
                driver.driver
            );
        }
    }

    #[test]
    fn only_existing_native_transports_are_available() {
        let available = built_in_provider_drivers()
            .into_iter()
            .filter(|driver| driver.runtime_available)
            .map(|driver| driver.instance_id)
            .collect::<Vec<_>>();
        assert_eq!(available, ["codex", "claude-code"]);
    }

    #[test]
    fn initial_inventory_is_available_without_waiting_for_processes() {
        let state = ProviderRuntimeState::new();
        let snapshots = state.snapshots();
        assert_eq!(snapshots.len(), 5);
        assert!(snapshots.iter().all(|snapshot| {
            snapshot.status == ProviderInventoryStatus::Checking
                && snapshot.installed.is_none()
                && snapshot.checked_at_ms.is_none()
        }));
    }

    #[test]
    fn parses_common_cli_version_formats() {
        assert_eq!(parse_cli_version("codex-cli 1.2.3"), Some("1.2.3".into()));
        assert_eq!(
            parse_cli_version("Claude Code v2.1.41"),
            Some("2.1.41".into())
        );
        assert_eq!(
            parse_cli_version("Cursor Agent\nversion: 0.48.2-beta.1"),
            Some("0.48.2-beta.1".into())
        );
        assert_eq!(parse_cli_version("no version returned"), None);
    }

    #[test]
    fn uses_cursor_about_and_version_flags_for_other_drivers() {
        let drivers = built_in_provider_drivers();
        for driver in drivers {
            let expected: &[&str] = if driver.driver == "cursor" {
                &["about"]
            } else {
                &["--version"]
            };
            assert_eq!(probe_arguments(&driver), expected);
        }
    }

    #[test]
    fn native_runtime_router_accepts_only_implemented_instances() {
        assert_eq!(
            native_provider_runtime("codex"),
            Ok(NativeProviderRuntime::Codex)
        );
        assert_eq!(
            native_provider_runtime("claude-code"),
            Ok(NativeProviderRuntime::Claude)
        );
        assert!(native_provider_runtime("cursor")
            .unwrap_err()
            .contains("not available yet"));
        assert!(native_provider_runtime("unknown")
            .unwrap_err()
            .contains("Unknown provider instance"));
    }

    #[test]
    fn runtime_events_are_sequenced_and_replayed_after_a_watermark() {
        let mut store = RuntimeEventStore::default();
        for index in 1..=3 {
            let event = store.record_with_limits(
                "codex",
                "session-a",
                &serde_json::json!({ "index": index }),
                4,
                10,
                10_000,
            );
            assert_eq!(event.sequence, index);
        }

        let replay = store.replay("codex", "session-a", Some(1));
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(replay.oldest_available_sequence, 1);
        assert_eq!(replay.latest_sequence, 3);
        assert!(!replay.reset_required);
    }

    #[test]
    fn runtime_replay_reports_when_requested_events_were_evicted() {
        let mut store = RuntimeEventStore::default();
        for index in 1..=4 {
            store.record_with_limits(
                "claude-code",
                "session-b",
                &serde_json::json!({ "index": index }),
                4,
                2,
                10_000,
            );
        }

        let replay = store.replay("claude-code", "session-b", Some(1));
        assert_eq!(replay.oldest_available_sequence, 3);
        assert_eq!(replay.latest_sequence, 4);
        assert!(replay.reset_required);
        assert_eq!(replay.events.len(), 2);
    }

    #[test]
    fn runtime_event_store_evicts_the_least_recently_used_stream() {
        let mut store = RuntimeEventStore::default();
        store.record_with_limits("codex", "old", &Value::Null, 2, 10, 10_000);
        store.record_with_limits("codex", "kept", &Value::Null, 2, 10, 10_000);
        store.record_with_limits("codex", "kept", &Value::Null, 2, 10, 10_000);
        store.record_with_limits("codex", "new", &Value::Null, 2, 10, 10_000);

        assert!(store.replay("codex", "old", Some(1)).reset_required);
        assert_eq!(store.replay("codex", "kept", None).latest_sequence, 2);
        assert_eq!(store.replay("codex", "new", None).latest_sequence, 1);
    }
}
