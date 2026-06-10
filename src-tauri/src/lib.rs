mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_workspace,
            commands::read_file,
            commands::recent_workspaces,
            commands::record_workspace_opened,
        ])
        .run(tauri::generate_context!())
        .expect("error while running synapse");
}
