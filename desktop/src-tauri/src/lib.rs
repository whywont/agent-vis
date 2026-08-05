mod claude_stream;
mod codex_app_server;
mod explain;
mod search;
mod secrets;
mod semantic;
mod sessions;
mod settings;
mod terminal;
mod workspace;

use claude_stream::{connect_claude_thread, send_claude_turn, ClaudeStreamState};
use codex_app_server::{
    compact_codex_thread, connect_codex_thread, interrupt_codex_turn, list_codex_mcp_servers,
    list_codex_models, list_codex_skills, read_codex_thread_status, respond_to_codex_approval,
    send_codex_turn, set_codex_thread_model, start_codex_review, CodexAppServerState,
};
use explain::explain_diff;
use search::{search_sessions, SearchIndexState};
use sessions::{delete_session, list_sessions, read_session_records};
use settings::{get_desktop_appearance, get_desktop_settings, save_desktop_settings};
use tauri::Manager;
use terminal::{resize_terminal, start_terminal, stop_terminal, write_terminal, TerminalState};
use workspace::{get_git_branch, read_workspace_file, save_workspace_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let search = SearchIndexState::new(app.handle())?;
            search.start_background_index();
            app.manage(search);
            app.manage(TerminalState::new());
            app.manage(CodexAppServerState::new());
            app.manage(ClaudeStreamState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            delete_session,
            search_sessions,
            read_session_records,
            get_desktop_settings,
            get_desktop_appearance,
            save_desktop_settings,
            explain_diff,
            get_git_branch,
            read_workspace_file,
            save_workspace_file,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            connect_codex_thread,
            send_codex_turn,
            compact_codex_thread,
            list_codex_models,
            set_codex_thread_model,
            read_codex_thread_status,
            list_codex_skills,
            list_codex_mcp_servers,
            start_codex_review,
            interrupt_codex_turn,
            respond_to_codex_approval,
            connect_claude_thread,
            send_claude_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-vis desktop");
}
