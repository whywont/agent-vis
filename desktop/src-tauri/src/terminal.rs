use crate::sessions::trusted_workspace_roots;
use crate::workspace::validate_workspace_root;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const MAX_TERMINAL_ID_LENGTH: usize = 160;

pub(crate) struct TerminalState {
    terminals: Mutex<HashMap<String, Child>>,
}

impl TerminalState {
    pub(crate) fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartTerminalRequest {
    terminal_id: String,
    workspace_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInputRequest {
    terminal_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopTerminalRequest {
    terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResizeTerminalRequest {
    terminal_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    terminal_id: String,
    data: String,
}

fn validate_terminal_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_TERMINAL_ID_LENGTH {
        return Err("Invalid terminal identifier.".to_owned());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err("Invalid terminal identifier.".to_owned());
    }
    Ok(value)
}

fn stop_terminal_process(mut child: Child) {
    // Each embedded shell becomes its own session/process group in spawn_shell.
    // Killing only the shell allows its foreground child (for example Codex) to
    // survive as an orphaned, CPU-hungry process after the dock is closed.
    let group_id = -(child.id() as i32);
    // SAFETY: a negative PID targets only the process group whose leader is
    // this owned terminal child. ESRCH simply means it already exited.
    if unsafe { libc::kill(group_id, libc::SIGHUP) } != 0 {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn decode_terminal_output(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let text = text.to_owned();
            pending.clear();
            text
        }
        Err(error) if error.error_len().is_none() => {
            // A multi-byte character was split across PTY reads. Emit only the
            // complete prefix and retain the unfinished suffix for next time.
            let valid = error.valid_up_to();
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            let remainder = pending.split_off(valid);
            *pending = remainder;
            text
        }
        Err(_) => {
            // Invalid bytes are unusual in a terminal stream, but should not
            // stall output forever. Render them lossily and resume cleanly.
            let text = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            text
        }
    }
}

// Spawn the login shell on a real PTY. The prior `script` shim injected its
// own control output and could not track pane resizing.
fn spawn_shell(workspace_root: &std::path::Path) -> Result<(Child, File, File), String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| value.starts_with('/'))
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: `openpty` initializes the two file descriptors on success.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } != 0
    {
        return Err(format!(
            "Unable to create terminal: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `openpty` returned owned file descriptors and File takes ownership.
    let master = unsafe { File::from_raw_fd(master) };
    // SAFETY: `openpty` returned owned file descriptors and File takes ownership.
    let slave = unsafe { File::from_raw_fd(slave) };
    let child_stdin = slave.try_clone().map_err(|error| error.to_string())?;
    let child_stdout = slave.try_clone().map_err(|error| error.to_string())?;
    let child_stderr = slave.try_clone().map_err(|error| error.to_string())?;
    let slave_fd = slave.as_raw_fd();
    // SAFETY: the child setup closure uses only async-signal-safe syscalls.
    let child = unsafe {
        Command::new(shell)
            .arg("-il")
            // macOS adds a saved-session banner when it sees a terminal
            // session. An embedded terminal should begin at its prompt.
            .env("SHELL_SESSIONS_DISABLE", "1")
            // Avoid Terminal.app hooks inherited by the desktop process. They
            // emit control sequences intended for macOS Terminal, not xterm.
            .env_remove("TERM_SESSION_ID")
            .env("INSIDE_EMACS", "agent-vis-terminal")
            .current_dir(workspace_root)
            .stdin(child_stdin)
            .stdout(child_stdout)
            .stderr(child_stderr)
            // SAFETY: this runs in the child just before exec, using only async-signal-safe syscalls.
            .pre_exec(move || {
                if libc::setsid() == -1
                    || libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0) == -1
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            })
            .spawn()
    }
    .map_err(|error| format!("Unable to start terminal: {error}"))?;
    drop(slave);
    let reader = master.try_clone().map_err(|error| error.to_string())?;
    Ok((child, master, reader))
}

#[tauri::command]
pub(crate) fn start_terminal(
    app: AppHandle,
    state: State<'_, TerminalState>,
    request: StartTerminalRequest,
) -> Result<(), String> {
    let terminal_id = validate_terminal_id(&request.terminal_id)?.to_owned();
    let roots = trusted_workspace_roots()?;
    let workspace_root = validate_workspace_root(&request.workspace_root, &roots)?;
    let (child, input, stdout) = spawn_shell(&workspace_root)?;

    if let Some(existing) = state
        .terminals
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .remove(&terminal_id)
    {
        stop_terminal_process(existing);
    }
    state
        .terminals
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .insert(terminal_id.clone(), child);

    let input = Arc::new(Mutex::new(input));
    let input_for_events = Arc::clone(&input);
    let app_for_output = app.clone();
    let output_id = terminal_id.clone();
    std::thread::spawn(move || {
        let mut output = stdout;
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();
        loop {
            match output.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let data = decode_terminal_output(&mut pending_utf8, &buffer[..size]);
                    if data.is_empty() {
                        continue;
                    }
                    let _ = app_for_output.emit(
                        "terminal-output",
                        TerminalOutput {
                            terminal_id: output_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
        drop(input_for_events);
    });

    // Keep the PTY input in a dedicated process-local stream. The child is
    // tracked for lifecycle management while input is addressed by terminal id.
    TERMINAL_INPUTS
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .insert(terminal_id, input);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decode_terminal_output;

    #[test]
    fn preserves_unicode_split_across_pty_reads() {
        let mut pending = Vec::new();
        let spinner = "⠋".as_bytes();

        assert_eq!(decode_terminal_output(&mut pending, &spinner[..2]), "");
        assert_eq!(decode_terminal_output(&mut pending, &spinner[2..]), "⠋");
        assert!(pending.is_empty());
    }
}

type TerminalInput = Arc<Mutex<File>>;
static TERMINAL_INPUTS: std::sync::LazyLock<Mutex<HashMap<String, TerminalInput>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub(crate) fn write_terminal(request: TerminalInputRequest) -> Result<(), String> {
    let terminal_id = validate_terminal_id(&request.terminal_id)?;
    let input = TERMINAL_INPUTS
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .get(terminal_id)
        .cloned()
        .ok_or_else(|| "Terminal is no longer running.".to_owned())?;
    let result = input
        .lock()
        .map_err(|_| "Terminal input is unavailable.".to_owned())?
        .write_all(request.data.as_bytes())
        .map_err(|error| format!("Unable to write to terminal: {error}"));
    result
}

#[tauri::command]
pub(crate) fn resize_terminal(request: ResizeTerminalRequest) -> Result<(), String> {
    let terminal_id = validate_terminal_id(&request.terminal_id)?;
    if request.cols == 0 || request.rows == 0 {
        return Ok(());
    }
    let input = TERMINAL_INPUTS
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .get(terminal_id)
        .cloned()
        .ok_or_else(|| "Terminal is no longer running.".to_owned())?;
    let size = libc::winsize {
        ws_row: request.rows,
        ws_col: request.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let input = input
        .lock()
        .map_err(|_| "Terminal input is unavailable.".to_owned())?;
    // SAFETY: the file is the master end of this terminal's PTY.
    if unsafe { libc::ioctl(input.as_raw_fd(), libc::TIOCSWINSZ, &size) } == -1 {
        return Err(format!(
            "Unable to resize terminal: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn stop_terminal(
    state: State<'_, TerminalState>,
    request: StopTerminalRequest,
) -> Result<(), String> {
    let terminal_id = validate_terminal_id(&request.terminal_id)?;
    TERMINAL_INPUTS
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .remove(terminal_id);
    if let Some(child) = state
        .terminals
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_owned())?
        .remove(terminal_id)
    {
        stop_terminal_process(child);
    }
    Ok(())
}
