use serde::Serialize;

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

#[tauri::command]
pub(crate) fn list_agent_provider_drivers() -> Vec<AgentProviderDriver> {
    built_in_provider_drivers()
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
}
