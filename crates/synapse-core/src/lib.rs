pub mod bridge;
pub mod config_sync;
pub mod discovery;
pub mod docid;
pub mod external_terminal;
pub mod fs_io;
pub mod git;
pub mod github;
pub mod links;
pub mod location;
pub mod merge;
pub mod migrate;
pub mod paths;
pub mod registry;
pub mod retrieval;
pub mod search;
pub mod secrets;
pub mod settings;
pub mod sftp;
pub mod ssh;
pub mod ssh_command;
pub mod ssh_config;
pub mod mcp_provision;
pub mod tree;
pub mod vfs;
pub mod walk;
pub mod watch;

pub use bridge::{generate_token, token_matches, LiveState, OpenTab};
pub use config_sync::ConfigSyncState;
pub use discovery::{find_for_cwd, remove_by_token, upsert, BridgeEntry, BridgeMap};
pub use docid::strip_doc_id;
pub use external_terminal::{launch_command, linux_auto_candidates, Launch, Platform};
pub use fs_io::{
    atomic_write, atomic_write_bytes, create_unique_folder, create_unique_note,
    ensure_writable_within, is_safe_file_name, workspace_write_lock,
};
pub use git::{ConflictChoice, ConflictPreview, FileCommit, GitWorkspace, SyncState, SyncStatus};
pub use links::{backlinks_for, build_graph, Backlink, GraphEdge, GraphNode, LinkGraph};
pub use location::{
    path_to_uri, urify_tree, Location, LocationError, SshLocation, DEFAULT_SSH_PORT,
};
pub use merge::{merge_agent_edit, merge_three_way, save_merge};
pub use migrate::remove_collab_dir;
pub use paths::{ensure_within, legacy_pdf_draw_sidecar, pdf_draw_sidecar_path, rel_path_within};
pub use registry::{recent_workspaces, record_opened};
pub use retrieval::{retrieve_context, RetrievalOptions, RetrievalResult, RetrievedSnippet};
pub use search::{search_workspace, SearchHit, SearchMatch, SearchOptions};
pub use sftp::SftpBackend;
pub use ssh::{
    connect as ssh_connect, expand_tilde, HostKeyPolicy, SshConfig, SshError, SshSession,
};
pub use ssh_command::{parse_ssh_command, SshCommandError, SshInvocation};
pub use ssh_config::{resolve_host, HostConfig};
pub use mcp_provision::{
    bridge_env, codex_config_snippet, ensure_gitignore_line, mcp_config_json, merge_mcp_config,
};
pub use tree::{build_tree, FileNode, FileType, NodeKind};
pub use vfs::{Backend, DirEntry, LocalBackend, Meta};
