mod auth;
mod commands;
mod sync;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(auth::AuthState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_workspace,
            commands::read_file,
            commands::write_file,
            commands::create_note,
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
            auth::github_login_start,
            auth::github_login_poll,
            auth::github_user,
            auth::github_logout,
            sync::sync_status,
            sync::sync_now,
            sync::resolve_conflict,
            sync::publish_workspace,
            sync::clone_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running synapse");
}
