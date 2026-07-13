# Synapse

[![CI](https://github.com/izagood/synapse/actions/workflows/ci.yml/badge.svg)](https://github.com/izagood/synapse/actions/workflows/ci.yml)
[![Release](https://github.com/izagood/synapse/actions/workflows/release-desktop.yml/badge.svg)](https://github.com/izagood/synapse/actions/workflows/release-desktop.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A desktop Markdown note app with Notion-style editing, safe HTML viewing, and
GitHub-based sync.

Synapse lets you open any local folder, write notes in a WYSIWYG editor, and keep
the underlying files as plain `.md` and `.html`. Your notes remain normal files
on disk, so they can be read by GitHub, Obsidian, editors, scripts, and other
Markdown tools.

## Features

- Open any local folder as a workspace.
- Keep notes as standard Markdown files.
- Edit Markdown with a Tiptap/ProseMirror WYSIWYG editor.
- Switch to raw Markdown source mode when needed.
- Preserve YAML frontmatter while editing.
- Paste or drop images into Markdown notes.
- Open `.html` files in a sanitized, sandboxed viewer.
- Sign in with GitHub Device Flow.
- Publish a local workspace to a GitHub repository.
- Clone an existing GitHub repository from the start screen.
- Sync with GitHub using the system `git` CLI.
- Resolve sync conflicts with keep-local, keep-remote, or keep-both actions.
- Manage all app settings globally instead of writing app config into each
  workspace.
- Use Quick Open, tabs, themes, and update checks.
- Open the OS's native terminal (Terminal.app, iTerm2, Windows Terminal, or a
  custom command) directly in the workspace folder instead of an embedded
  terminal panel.
- Let AI coding agents running in that external terminal connect back to Synapse
  through an MCP server that discovers the running app via a local
  `bridge.json` file — no manual port/token setup required.

## Screenshots

Screenshots are not included yet. When available, they should live under
`docs/images/` and be embedded here.

## Installation

Prebuilt desktop installers are produced by the release workflow for:

- macOS: `.dmg`
- Windows: `.msi`

Unsigned builds may show a macOS Gatekeeper or Windows SmartScreen warning on
first launch. See [Packaging](docs/PACKAGING.md) for details.

If a release installer is not available, build from source.

## Quick Start

```bash
git clone https://github.com/izagood/synapse.git
cd synapse
npm install
npm run tauri dev
```

Then:

1. Click **Open Folder**.
2. Choose a folder for your notes.
3. Create or open a `.md` file.
4. Edit in WYSIWYG mode or switch to source mode.
5. Optional: sign in to GitHub and publish or sync the workspace.

## Usage

### Workspaces

A workspace is a normal folder on your computer. Synapse does not require a vault
setup step and does not create a Synapse-specific config directory inside the
workspace.

Use the start screen to open a folder, reopen a recent folder, or clone an
existing GitHub repository.

### File Tree

The left sidebar shows the workspace contents.

- Click folders to expand or collapse them.
- Click files to open them in tabs.
- Use the sidebar plus button to create a new note.
- Right-click files or folders to rename, duplicate files, copy paths, or delete.
- Drag the sidebar edge to resize it.

### Markdown Editing

Markdown files open in the WYSIWYG editor by default. Synapse saves back to `.md`
so the files remain portable.

Supported content includes headings, paragraphs, ordered and unordered lists,
task lists, block quotes, code blocks, horizontal rules, tables, links, images,
and frontmatter preservation.

Use source mode for raw Markdown editing, especially when working with
frontmatter or Markdown constructs that the WYSIWYG editor may not fully
preserve.

### HTML Viewing

HTML files open in Synapse's built-in viewer. The default mode sanitizes HTML and
blocks document scripts. External resources and script execution can be changed
in Settings for trusted documents.

Switch to source mode while an HTML file is open to inspect the raw HTML.

### GitHub Sync

Synapse syncs through local Git and GitHub.

1. Install Git.
2. Open a workspace.
3. Click **GitHub Login** in the status bar.
4. Complete the GitHub Device Flow login.
5. Publish the folder to a new GitHub repository or clone an existing repository.
6. Click the sync indicator to sync immediately, or enable automatic sync.

The status bar exposes simple states:

- **Synced**: local and remote are up to date.
- **Sync Needed**: local or remote changes need to be synchronized.
- **Conflict**: incompatible changes need a decision.

Conflict actions:

- **Keep Mine** keeps the local version.
- **Use Remote** takes the remote version.
- **Keep Both** preserves both versions.

### Settings

Synapse has one global settings screen. Current settings include:

- Theme: system, light, or dark.
- Language: Korean or English.
- Editor font, font size, and auto-save delay.
- Delete confirmation behavior.
- Automatic sync and sync interval.
- HTML viewer network and script permissions.
- Update checks and installation.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+S` | Save the active file |
| `Ctrl/Cmd+P` | Quick Open |
| `Ctrl/Cmd+B` | Toggle the sidebar |
| `Ctrl/Cmd+J` | Open the external terminal in the workspace folder |

## Development

Required tools:

- Node.js 22+
- Rust stable
- Platform-specific Tauri dependencies from the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)

Install dependencies:

```bash
npm install
```

Run the browser UI with mock IPC:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run tauri dev
```

Run frontend checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Run GUI-independent Rust core checks:

```bash
cd crates/synapse-core
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Building

Build a desktop bundle:

```bash
npm run tauri build
```

GitHub sync requires a GitHub OAuth App client ID at build time:

```bash
SYNAPSE_GITHUB_CLIENT_ID=<client_id> npm run tauri build
```

Create the OAuth App in GitHub Developer settings and enable Device Flow. The
callback URL can be any value because Synapse uses Device Flow.

Release packaging and updater details are documented in
[docs/PACKAGING.md](docs/PACKAGING.md).

## Project Structure

```text
synapse/
├── src/                  # React frontend
├── src-tauri/            # Tauri desktop shell and command layer
├── crates/synapse-core/  # GUI-independent Rust core logic
├── docs/                 # Requirements, architecture, packaging, plans
└── .github/workflows/    # CI and desktop release workflows
```

Important frontend areas:

- `src/ipc/` - typed IPC boundary and browser mock IPC.
- `src/features/workspace/` - folder opening, file tree, tabs, Quick Open.
- `src/features/editor/` - Markdown editor, source mode, frontmatter, links,
  images.
- `src/features/html-viewer/` - sanitized and sandboxed HTML rendering.
- `src/features/sync/` - GitHub login, publishing, sync status, conflicts.
- `src/features/settings/` - global settings UI.

## Roadmap

Planned post-MVP work includes:

- Full-text search.
- Wiki links and backlinks.
- File history.
- HTML to Markdown import and Markdown to HTML export.
- More advanced conflict review.
- AI-assisted note workflows.
- Plugin support.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and the plan documents in
`docs/` for more detail.

## Contributing

Issues and pull requests are welcome. By submitting a pull request, you agree
to license your contribution under the [Apache License 2.0](LICENSE).

### Filing an issue

Hit a bug or have something you'd like changed while using Synapse? Please open
an issue rather than sending free-form feedback — structured reports are far
easier to act on. Two templates are provided under
[`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE):

- **🐞 Bug report** — something behaves incorrectly, crashes, or produces an
  unexpected result.
- **🔧 Change request / feature** — propose a change to existing behavior, the
  UI, defaults, or docs, or request a new feature.

> 🌐 **Any language is welcome.** File your issue in whatever language you're
> most comfortable with — English, 한국어, 日本語, etc. Maintainers will translate
> as needed; don't let language be a barrier to reporting.

For open-ended questions or design debate, start a
[Discussion](https://github.com/izagood/synapse/discussions) instead.

### Pull requests

Before opening a pull request, run the relevant checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For Rust core changes, also run:

```bash
cd crates/synapse-core
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Documentation

- [Requirements](docs/REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Packaging](docs/PACKAGING.md)
- [Plan v0.2](docs/PLAN-v0.2.md)
- [Plan v0.4](docs/PLAN-v0.4.md)
- [Plan i18n](docs/PLAN-i18n.md)

## License

Synapse is released under the [Apache License 2.0](LICENSE).

Copyright (c) 2026 Jaebin Lee.
