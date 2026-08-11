use serde::Serialize;
use std::io::ErrorKind;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use crate::shell_environment::apply_desktop_shell_environment;

const PROVIDER_INVENTORY_EVENT: &str = "agent-provider-inventory-updated";
const PROVIDER_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PROBE_DETAIL_CHARS: usize = 500;

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
}
