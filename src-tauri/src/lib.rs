mod agent;
mod auth;
mod commands;
mod config_sync;
mod dock;
mod remote;
mod sync;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            dock::install(app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(auth::AuthState::default())
        .manage(agent::AgentState::default())
        .manage(remote::RemoteState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_workspace,
            remote::connect_remote,
            remote::disconnect_remote,
            commands::read_file,
            commands::write_file,
            commands::save_doc,
            commands::agent_edit_file,
            commands::backlinks,
            commands::link_graph,
            commands::create_note,
            commands::create_folder,
            commands::search_workspace,
            commands::retrieve_notes,
            commands::recent_workspaces,
            commands::record_workspace_opened,
            commands::get_last_workspace,
            commands::clear_last_workspace,
            commands::get_workspace_state,
            commands::set_workspace_state,
            commands::get_settings,
            commands::update_settings,
            commands::viewer_cache_write,
            commands::new_window,
            commands::save_image,
            commands::write_binary_unique,
            commands::rename_path,
            commands::delete_path,
            commands::duplicate_path,
            commands::move_path,
            auth::github_login_start,
            auth::github_login_poll,
            auth::github_user,
            auth::github_logout,
            auth::set_agent_api_key,
            auth::clear_agent_api_key,
            auth::has_agent_api_key,
            sync::sync_status,
            sync::sync_now,
            sync::resolve_conflict,
            sync::conflict_preview,
            sync::publish_workspace,
            sync::clone_repo,
            config_sync::config_sync_status,
            config_sync::config_sync_autolink,
            config_sync::link_config_repo,
            config_sync::unlink_config_repo,
            config_sync::config_sync_now,
            sync::file_history,
            sync::file_at_revision,
            agent::agent_status,
            agent::agent_send,
            agent::agent_respond_permission,
            agent::agent_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running synapse");
}
