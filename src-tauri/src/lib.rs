mod auth;
mod bridge;
mod commands;
mod config_sync;
mod dock;
mod mcp;
mod remote;
mod sync;
mod watcher;

pub fn run() {
    // 라이브 상태 브리지: 관리 상태와 서버 스레드가 같은 inner를 공유한다.
    let bridge_state = bridge::BridgeState::default();
    let bridge_inner = bridge_state.0.clone();
    tauri::Builder::default()
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            dock::install(app.handle().clone());
            // loopback HTTP 브리지 기동(실패해도 앱 본체는 정상 동작).
            bridge::start(bridge_inner.clone());
            // 크래시로 남은 죽은 pid의 discovery 항목을 정리한다.
            mcp::sweep_stale_discovery();
            Ok(())
        })
        .on_window_event(|window, event| {
            // 윈도우가 닫히면 그 윈도우의 브리지 세션·discovery 항목을 정리해
            // 누수/좀비를 막는다.
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                if let Some(state) = window.try_state::<bridge::BridgeState>() {
                    let _ = mcp::unpublish_for(&state.0, window.label());
                    state.0.drop_window(window.label());
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 트리 항목을 OS(Finder/탐색기)로 끌어 내보내기 (네이티브 드래그아웃)
        .plugin(tauri_plugin_drag::init())
        .manage(auth::AuthState::default())
        .manage(remote::RemoteState::default())
        .manage(watcher::WatcherState::default())
        .manage(bridge_state)
        .invoke_handler(tauri::generate_handler![
            commands::list_workspace,
            commands::migrate_workspace,
            remote::connect_remote,
            remote::disconnect_remote,
            remote::parse_ssh_command,
            remote::list_remote_dir,
            commands::read_file,
            commands::write_file,
            commands::read_pdf_draw,
            commands::write_pdf_draw,
            commands::save_doc,
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
            commands::open_external_terminal,
            commands::viewer_cache_write,
            commands::new_window,
            commands::save_image,
            commands::write_binary_unique,
            commands::rename_path,
            commands::delete_path,
            commands::duplicate_path,
            commands::move_path,
            commands::drag_icon_path,
            bridge::bridge_push_state,
            mcp::bridge_publish_discovery,
            mcp::bridge_unpublish_discovery,
            auth::github_login_start,
            auth::github_login_poll,
            auth::github_user,
            auth::github_logout,
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
            watcher::start_watching,
            watcher::stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running synapse");
}
