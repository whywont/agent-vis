mod claude_stream;
mod codex_app_server;
mod explain;
mod mesh;
mod search;
mod secrets;
mod semantic;
mod sessions;
mod settings;
mod terminal;
mod workspace;

use claude_stream::{
    connect_claude_thread, send_claude_turn, start_claude_session, ClaudeStreamState,
};
use codex_app_server::{
    compact_codex_thread, connect_codex_thread, interrupt_codex_turn, list_codex_mcp_servers,
    list_codex_models, list_codex_skills, read_codex_thread_status, respond_to_codex_approval,
    send_codex_turn, set_codex_thread_model, start_codex_review, start_codex_session,
    CodexAppServerState,
};
use explain::explain_diff;
use mesh::{
    connect_mesh_peer, get_mesh_status, regenerate_mesh_identity, sync_all_mesh_peers, MeshState,
};
use search::{search_sessions, SearchIndexState};
use sessions::{delete_session, get_session_modified, list_sessions, read_session_records};
use settings::{
    get_desktop_appearance, get_desktop_settings, get_session_sharing_settings,
    save_desktop_settings, update_session_share,
};
use tauri::Manager;
use terminal::{resize_terminal, start_terminal, stop_terminal, write_terminal, TerminalState};
use workspace::{
    choose_workspace_directory, get_git_branch, read_workspace_file, resolve_workspace_filepaths,
    save_workspace_file,
};

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
            app.manage(MeshState::new(app.handle().clone())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_session_modified,
            delete_session,
            search_sessions,
            read_session_records,
            get_desktop_settings,
            get_session_sharing_settings,
            get_desktop_appearance,
            save_desktop_settings,
            update_session_share,
            get_mesh_status,
            regenerate_mesh_identity,
            connect_mesh_peer,
            sync_all_mesh_peers,
            explain_diff,
            get_git_branch,
            choose_workspace_directory,
            resolve_workspace_filepaths,
            read_workspace_file,
            save_workspace_file,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            connect_codex_thread,
            start_codex_session,
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
            start_claude_session,
            send_claude_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-vis desktop");
}
