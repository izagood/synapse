pub mod agent;
pub mod collab;
pub mod config_sync;
pub mod fs_io;
pub mod git;
pub mod github;
pub mod links;
pub mod location;
pub mod paths;
pub mod registry;
pub mod retrieval;
pub mod search;
pub mod secrets;
pub mod settings;
pub mod sftp;
pub mod ssh;
pub mod tree;
pub mod vfs;
pub mod walk;

pub use collab::CollabStore;
pub use config_sync::ConfigSyncState;
pub use fs_io::{
    atomic_write, atomic_write_bytes, create_unique_note, ensure_writable_within, is_safe_file_name,
};
pub use git::{ConflictChoice, ConflictPreview, FileCommit, GitWorkspace, SyncState, SyncStatus};
pub use links::{backlinks_for, build_graph, Backlink, GraphEdge, GraphNode, LinkGraph};
pub use location::{
    path_to_uri, urify_tree, Location, LocationError, SshLocation, DEFAULT_SSH_PORT,
};
pub use paths::{ensure_within, rel_path_within};
pub use registry::{recent_workspaces, record_opened};
pub use retrieval::{retrieve_context, RetrievalOptions, RetrievalResult, RetrievedSnippet};
pub use search::{search_workspace, SearchHit, SearchMatch, SearchOptions};
pub use sftp::SftpBackend;
pub use ssh::{connect as ssh_connect, HostKeyPolicy, SshConfig, SshError, SshSession};
pub use tree::{build_tree, FileNode, FileType, NodeKind};
pub use vfs::{Backend, DirEntry, LocalBackend, Meta};
