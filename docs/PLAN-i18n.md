# PLAN i18n - Global language support

Goal: make Synapse usable by global users while keeping Korean as the current
default and avoiding workspace-specific language files.

## Current State

- `Settings.appearance.language` already exists in both Rust and TypeScript, with
  default value `ko`.
- The settings modal does not expose language selection yet.
- User-facing strings are mostly hardcoded directly in React components.
- Some strings are dynamic status/error text from stores or IPC results and need
  careful key design instead of direct string replacement.
- Documentation already lists language as an initial global setting in
  `FR-5.3`.

## Target Scope

Initial supported locales:

- `ko` - Korean, existing baseline and fallback locale.
- `en` - English, first global locale.

Locale behavior:

- Store language in the existing global settings file.
- Use `ko` as fallback when a key is missing.
- Add an `auto` option only after OS/browser locale detection is validated in
  Tauri WebView on Windows, macOS, and Linux.
- Do not translate user file names, workspace content, markdown content, git
  output, or raw external error messages unless they are wrapped by app-owned UI
  text.

## Architecture

Add a small frontend i18n layer instead of introducing a heavy framework first:

```text
src/i18n/
  locales/ko.ts
  locales/en.ts
  index.ts
```

The layer should provide:

- `SUPPORTED_LOCALES` and locale metadata for the settings dropdown.
- A typed translation key object or function that catches missing keys during
  TypeScript checks where practical.
- `useT()` React hook that reads `settings.appearance.language`.
- Parameter interpolation for simple values such as versions, counts, paths, and
  keyboard shortcuts.
- Fallback lookup from selected locale to Korean.

Use plain objects at first. Reconsider `i18next` or FormatJS only when plural
rules, ICU messages, or third-party translation workflows become necessary.

## Implementation Phases

### Phase 1 - Foundation

- Add `src/i18n` with Korean and English dictionaries.
- Add unit tests for fallback behavior and interpolation.
- Add a settings dropdown for `appearance.language`.
- Ensure the language setting persists through existing `getSettings` and
  `updateSettings` without Rust schema changes.
- Keep Korean as default to avoid surprising existing users.

### Phase 2 - Convert Shell UI

Convert high-visibility app shell strings first:

- Start screen and recent workspace actions.
- Activity bar, tab bar, quick open modal, and workspace empty states.
- Settings modal, update section, and global buttons.
- Sync bar, login modal, clone form, and publish controls.
- Agent panel labels and empty/error states.

Acceptance criteria:

- All converted components render from translation keys.
- No visible regression when `language = ko`.
- Switching language in settings updates the UI without app restart.

### Phase 3 - Convert Editor and Viewer UI

- Editor placeholders, source/WYSIWYG labels, image/file operation prompts.
- HTML viewer loading and error placeholders.
- File tree context menu actions and destructive action confirmations.
- Conflict and delete confirmation copy.

Acceptance criteria:

- Destructive confirmations are translated and still include the affected file
  or folder name.
- Dynamic labels keep stable layout in both Korean and English.

### Phase 4 - Error and Status Normalization

- Replace app-owned plain error strings with stable error codes plus translated
  display messages.
- Keep raw Rust/git/GitHub messages available in details text for debugging.
- Add helper functions for common status labels such as sync state, file type,
  update state, and agent run state.

Acceptance criteria:

- Common user-facing failures show localized primary messages.
- Technical detail is not lost.

### Phase 5 - QA and Release Readiness

- Add an i18n key coverage test that verifies `en` contains every key in `ko`.
- Add targeted component tests for language switching in settings and key shell
  surfaces.
- Run visual checks for longer English labels and compact Korean labels.
- Update README settings documentation to mention language support.
- Add a short translator note describing tone, placeholders, and key naming.

## Key Naming Guidelines

- Prefer feature-scoped keys: `settings.title`, `sync.login`, `tabs.close`.
- Use parameters for values: `update.installVersion({ version })`.
- Do not build sentences by concatenating translated fragments.
- Keep labels and aria/title text as separate keys when wording differs.
- Keep dangerous action copy explicit and complete in every locale.

## Risks

| Risk | Mitigation |
|---|---|
| Missing translations produce mixed UI | Fallback to `ko`, coverage test for locale parity |
| Long English labels break compact controls | Visual pass on settings, tab bar, sync bar, modals |
| Dynamic backend errors are hard to translate | Translate app-owned wrapper text, preserve raw details |
| Translation changes become noisy | Keep dictionaries sorted by feature and review in small phases |
| Future pluralization needs grow | Start simple, migrate to ICU-capable library only when needed |

## Done Definition

- A user can choose Korean or English from Settings.
- The app shell, settings, sync, editor controls, viewer states, file actions, and
  agent panel use localized text.
- Locale persists globally and does not create files in workspaces.
- Tests cover fallback, interpolation, locale parity, and language switching.
- README documents the language setting.
