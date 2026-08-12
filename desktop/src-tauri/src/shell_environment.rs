use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(2);
const ENVIRONMENT_CAPTURE_START: &str = "__AGENT_VIS_ENV_";
const LOGIN_SHELL_ENVIRONMENT_NAMES: [&str; 14] = [
    "PATH",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "SSH_AUTH_SOCK",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "HOMEBREW_REPOSITORY",
    "XDG_CONFIG_HOME",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_DESKTOP",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
];

static DESKTOP_SHELL_ENVIRONMENT: OnceLock<HashMap<OsString, OsString>> = OnceLock::new();

pub(crate) fn initialize_desktop_shell_environment() {
    let _ = DESKTOP_SHELL_ENVIRONMENT.get_or_init(resolve_desktop_shell_environment);
}

pub(crate) fn apply_desktop_shell_environment(command: &mut Command) -> &mut Command {
    let environment = DESKTOP_SHELL_ENVIRONMENT.get_or_init(resolve_desktop_shell_environment);
    command.envs(environment)
}

fn resolve_desktop_shell_environment() -> HashMap<OsString, OsString> {
    #[cfg(unix)]
    {
        resolve_posix_shell_environment()
    }
    #[cfg(not(unix))]
    {
        HashMap::new()
    }
}

#[cfg(unix)]
fn resolve_posix_shell_environment() -> HashMap<OsString, OsString> {
    let mut shell_environment = HashMap::new();
    for shell in login_shell_candidates() {
        if let Some(output) = run_capture(
            &shell,
            &["-ilc", &build_environment_capture_command()],
            LOGIN_SHELL_TIMEOUT,
        ) {
            shell_environment = extract_environment(&String::from_utf8_lossy(&output.stdout));
            if shell_environment.contains_key("PATH") {
                break;
            }
        }
    }

    #[cfg(target_os = "macos")]
    if !shell_environment.contains_key("PATH") {
        if let Some(output) =
            run_capture("/bin/launchctl", &["getenv", "PATH"], LOGIN_SHELL_TIMEOUT)
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !path.is_empty() {
                shell_environment.insert("PATH".to_owned(), path);
            }
        }
    }

    let inherited = std::env::vars().collect::<HashMap<_, _>>();
    let mut patch = HashMap::new();
    if let Some(path) = merge_paths(
        shell_environment.get("PATH").map(String::as_str),
        inherited.get("PATH").map(String::as_str),
    ) {
        patch.insert(OsString::from("PATH"), OsString::from(path));
    }

    if !inherited.contains_key("SSH_AUTH_SOCK") {
        copy_environment_value(&shell_environment, &mut patch, "SSH_AUTH_SOCK");
    }

    for name in [
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "XDG_SESSION_TYPE",
    ] {
        copy_environment_value(&shell_environment, &mut patch, name);
    }

    for name in [
        "DISPLAY",
        "HOMEBREW_PREFIX",
        "HOMEBREW_CELLAR",
        "HOMEBREW_REPOSITORY",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
        "WAYLAND_DISPLAY",
    ] {
        if !inherited.contains_key(name) {
            copy_environment_value(&shell_environment, &mut patch, name);
        }
    }
    patch
}

#[cfg(unix)]
fn login_shell_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() {
            candidates.push(shell);
        }
    }
    #[cfg(target_os = "macos")]
    candidates.push("/bin/zsh".to_owned());
    #[cfg(target_os = "linux")]
    candidates.push("/bin/bash".to_owned());
    candidates.dedup();
    candidates
}

#[cfg(unix)]
fn build_environment_capture_command() -> String {
    LOGIN_SHELL_ENVIRONMENT_NAMES
        .iter()
        .map(|name| {
            format!(
                "printf '%s\\n' '{ENVIRONMENT_CAPTURE_START}{name}_START__'; printenv {name} || true; printf '%s\\n' '{ENVIRONMENT_CAPTURE_START}{name}_END__'"
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn extract_environment(output: &str) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    for name in LOGIN_SHELL_ENVIRONMENT_NAMES {
        let start_marker = format!("{ENVIRONMENT_CAPTURE_START}{name}_START__");
        let end_marker = format!("{ENVIRONMENT_CAPTURE_START}{name}_END__");
        let Some(start) = output.find(&start_marker) else {
            continue;
        };
        let value_start = start + start_marker.len();
        let Some(relative_end) = output[value_start..].find(&end_marker) else {
            continue;
        };
        let value = output[value_start..value_start + relative_end]
            .trim_matches(['\r', '\n'])
            .to_owned();
        if !value.is_empty() {
            environment.insert(name.to_owned(), value);
        }
    }
    environment
}

fn merge_paths(preferred: Option<&str>, inherited: Option<&str>) -> Option<String> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for path in [preferred, inherited].into_iter().flatten() {
        for entry in std::env::split_paths(path) {
            if !entry.as_os_str().is_empty() && seen.insert(entry.clone()) {
                entries.push(entry);
            }
        }
    }
    (!entries.is_empty()).then(|| {
        std::env::join_paths(entries)
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    })
}

#[cfg(unix)]
fn copy_environment_value(
    source: &HashMap<String, String>,
    destination: &mut HashMap<OsString, OsString>,
    name: &str,
) {
    if let Some(value) = source.get(name) {
        destination.insert(OsString::from(name), OsString::from(value));
    }
}

fn run_capture(executable: &str, arguments: &[&str], timeout: Duration) -> Option<Output> {
    let mut child = Command::new(executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_environment_between_markers_despite_shell_noise() {
        let output = "welcome\n__AGENT_VIS_ENV_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__AGENT_VIS_ENV_PATH_END__\n__AGENT_VIS_ENV_SSH_AUTH_SOCK_START__\n/tmp/ssh.sock\n__AGENT_VIS_ENV_SSH_AUTH_SOCK_END__\ngoodbye";
        let environment = extract_environment(output);
        assert_eq!(
            environment.get("PATH").unwrap(),
            "/opt/homebrew/bin:/usr/bin"
        );
        assert_eq!(environment.get("SSH_AUTH_SOCK").unwrap(), "/tmp/ssh.sock");
    }

    #[test]
    fn merges_preferred_and_inherited_paths_without_duplicates() {
        let delimiter = if cfg!(windows) { ";" } else { ":" };
        let preferred = ["/preferred", "/shared"].join(delimiter);
        let inherited = ["/shared", "/inherited"].join(delimiter);
        let expected = ["/preferred", "/shared", "/inherited"].join(delimiter);
        assert_eq!(
            merge_paths(Some(&preferred), Some(&inherited)),
            Some(expected)
        );
    }
}
