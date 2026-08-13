use serde_json::Value;
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnActivity {
    Active,
    Idle,
}

pub(crate) struct AgentTurnSleepInhibitor {
    active_sessions: HashSet<String>,
    #[cfg(target_os = "macos")]
    caffeinate: Option<Child>,
}

impl AgentTurnSleepInhibitor {
    pub(crate) fn new() -> Self {
        Self {
            active_sessions: HashSet::new(),
            #[cfg(target_os = "macos")]
            caffeinate: None,
        }
    }

    pub(crate) fn observe(
        &mut self,
        provider_instance_id: &str,
        session_key: &str,
        message: &Value,
    ) {
        let Some(activity) = turn_activity(provider_instance_id, message) else {
            return;
        };
        let key = format!("{provider_instance_id}:{session_key}");
        match activity {
            TurnActivity::Active => {
                self.active_sessions.insert(key);
            }
            TurnActivity::Idle => {
                self.active_sessions.remove(&key);
            }
        }
        self.reconcile();
    }

    #[cfg(target_os = "macos")]
    fn reconcile(&mut self) {
        if self.active_sessions.is_empty() {
            if let Some(mut child) = self.caffeinate.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return;
        }
        let running = self
            .caffeinate
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none());
        if running {
            return;
        }
        self.caffeinate = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                eprintln!("Unable to prevent idle system sleep during an agent turn: {error}");
                error
            })
            .ok();
    }

    #[cfg(not(target_os = "macos"))]
    fn reconcile(&mut self) {}
}

#[cfg(target_os = "macos")]
impl Drop for AgentTurnSleepInhibitor {
    fn drop(&mut self) {
        if let Some(mut child) = self.caffeinate.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub(crate) fn turn_activity(provider_instance_id: &str, message: &Value) -> Option<TurnActivity> {
    match provider_instance_id {
        "codex" => codex_turn_activity(message),
        "claude-code" => claude_turn_activity(message),
        _ => None,
    }
}

fn codex_turn_activity(message: &Value) -> Option<TurnActivity> {
    match message.get("method").and_then(Value::as_str) {
        Some("turn/started") => Some(TurnActivity::Active),
        Some("turn/completed") | Some("agent-vis/disconnected") => Some(TurnActivity::Idle),
        Some("thread/status/changed") => match message
            .get("params")
            .and_then(|params| params.get("status"))
            .and_then(|status| status.get("type"))
            .and_then(Value::as_str)
        {
            Some("idle") => Some(TurnActivity::Idle),
            Some("active") => Some(TurnActivity::Active),
            _ => None,
        },
        _ => None,
    }
}

fn claude_turn_activity(message: &Value) -> Option<TurnActivity> {
    match message.get("type").and_then(Value::as_str) {
        Some("system") if message.get("status").and_then(Value::as_str) == Some("requesting") => {
            Some(TurnActivity::Active)
        }
        Some("result") | Some("agent-vis/disconnected") => Some(TurnActivity::Idle),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{turn_activity, TurnActivity};
    use serde_json::json;

    #[test]
    fn recognizes_codex_turn_boundaries() {
        assert_eq!(
            turn_activity("codex", &json!({ "method": "turn/started" })),
            Some(TurnActivity::Active)
        );
        assert_eq!(
            turn_activity("codex", &json!({ "method": "turn/completed" })),
            Some(TurnActivity::Idle)
        );
        assert_eq!(
            turn_activity(
                "codex",
                &json!({
                    "method": "thread/status/changed",
                    "params": { "status": { "type": "active" } }
                })
            ),
            Some(TurnActivity::Active)
        );
        assert_eq!(
            turn_activity(
                "codex",
                &json!({
                    "method": "thread/status/changed",
                    "params": { "status": { "type": "idle" } }
                })
            ),
            Some(TurnActivity::Idle)
        );
    }

    #[test]
    fn recognizes_claude_turn_boundaries() {
        assert_eq!(
            turn_activity(
                "claude-code",
                &json!({ "type": "system", "status": "requesting" })
            ),
            Some(TurnActivity::Active)
        );
        assert_eq!(
            turn_activity("claude-code", &json!({ "type": "result" })),
            Some(TurnActivity::Idle)
        );
    }

    #[test]
    fn ignores_stream_content_and_unknown_providers() {
        assert_eq!(
            turn_activity("codex", &json!({ "method": "item/completed" })),
            None
        );
        assert_eq!(
            turn_activity("claude-code", &json!({ "type": "assistant" })),
            None
        );
        assert_eq!(
            turn_activity("grok", &json!({ "method": "turn/started" })),
            None
        );
    }
}
