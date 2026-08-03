mod explain;
mod search;
mod secrets;
mod sessions;
mod settings;
mod workspace;

use explain::explain_diff;
use search::{search_sessions, SearchIndexState};
use sessions::{list_sessions, read_session_records};
use settings::{get_desktop_settings, save_desktop_settings};
use tauri::Manager;
use workspace::{get_git_branch, read_workspace_file, save_workspace_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let search = SearchIndexState::new(app.handle())?;
            search.start_background_index();
            app.manage(search);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            search_sessions,
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
