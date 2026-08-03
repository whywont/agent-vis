mod explain;
mod secrets;
mod sessions;
mod settings;
mod workspace;

use explain::explain_diff;
use sessions::{list_sessions, read_session_records};
use settings::{get_desktop_settings, save_desktop_settings};
use workspace::{get_git_branch, read_workspace_file, save_workspace_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            read_session_records,
            get_desktop_settings,
            save_desktop_settings,
            explain_diff,
            get_git_branch,
            read_workspace_file,
            save_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-vis desktop");
}
