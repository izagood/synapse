pub mod agent;
pub mod collab;
pub mod fs_io;
pub mod git;
pub mod github;
pub mod paths;
pub mod registry;
pub mod search;
pub mod settings;
pub mod tree;

pub use collab::CollabStore;
pub use fs_io::{atomic_write, atomic_write_bytes, create_unique_note, ensure_writable_within};
pub use git::{ConflictChoice, GitWorkspace, SyncState, SyncStatus};
pub use paths::ensure_within;
pub use registry::{recent_workspaces, record_opened};
pub use search::{search_workspace, SearchHit, SearchMatch, SearchOptions};
pub use tree::{build_tree, FileNode, FileType, NodeKind};
