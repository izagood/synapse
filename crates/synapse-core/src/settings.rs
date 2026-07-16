//! 앱 전역 설정 (FR-5). 워크스페이스 폴더가 아닌 단 한 곳에만 저장한다.
//! 필드 단위 serde 기본값이라 일부만 적힌(또는 과거 버전의) 파일도 안전하게 읽힌다.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// 설정 파일 이름. config_sync(코어/셸)도 이 단일 출처를 참조한다.
pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub theme: String, // "system" | "light" | "dark" | "pink"
    pub language: String,
    /// 활성 테마 위에 덮어쓰는 사용자 색상 (키→hex). 비어 있으면 테마 기본값.
    /// 프런트가 보낸 그대로 저장만 한다(코어는 색을 해석하지 않는다).
    pub custom_colors: BTreeMap<String, String>,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            theme: "system".into(),
            language: "ko".into(),
            custom_colors: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    pub font_family: String,
    pub font_size: u32,
    pub auto_save_delay_ms: u64,
    /// 소스/WYSIWYG 에디터에 줄 번호를 표시할지 (단축키/설정으로 토글)
    pub show_line_numbers: bool,
    /// 에디터 하단 백링크 패널을 표시할지 (설정/커맨드로 토글, 기본 숨김)
    pub show_backlinks: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            font_family: "system-ui".into(),
            font_size: 16,
            auto_save_delay_ms: 1000,
            show_line_numbers: false,
            show_backlinks: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettings {
    pub auto: bool,
    pub interval_minutes: u32,
}

impl Default for SyncSettings {
    fn default() -> Self {
        SyncSettings {
            auto: true,
            interval_minutes: 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HtmlViewerSettings {
    pub allow_scripts: bool,
    pub allow_network: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilesSettings {
    pub confirm_delete: bool,
}

impl Default for FilesSettings {
    fn default() -> Self {
        FilesSettings {
            confirm_delete: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    /// macOS: terminal|iterm2|custom / Windows: wt|cmd|custom / Linux: auto|custom
    pub external: String,
    /// 커스텀 명령 템플릿("{{cwd}}" 치환). 빈 값이면 기본 런처.
    pub custom_command: String,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        // 플랫폼별 1순위 기본값.
        let external = if cfg!(target_os = "macos") {
            "terminal"
        } else if cfg!(target_os = "windows") {
            "wt"
        } else {
            "auto"
        };
        TerminalSettings {
            external: external.into(),
            custom_command: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub appearance: Appearance,
    pub editor: EditorSettings,
    pub sync: SyncSettings,
    pub html_viewer: HtmlViewerSettings,
    pub files: FilesSettings,
    pub terminal: TerminalSettings,
}

pub fn load_settings(config_dir: &Path) -> Settings {
    match fs::read_to_string(config_dir.join(SETTINGS_FILE)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save_settings(config_dir: &Path, settings: &Settings) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let text = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
    crate::fs_io::atomic_write(&config_dir.join(SETTINGS_FILE), &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_settings(dir.path()), Settings::default());
        fs::write(dir.path().join(SETTINGS_FILE), "{ broken").unwrap();
        assert_eq!(load_settings(dir.path()), Settings::default());
    }

    #[test]
    fn roundtrips_saved_settings() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.appearance.theme = "dark".into();
        s.editor.font_size = 18;
        s.sync.auto = false;
        save_settings(dir.path(), &s).unwrap();
        assert_eq!(load_settings(dir.path()), s);
    }

    #[test]
    fn tolerates_partial_files_with_field_defaults() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"appearance":{"theme":"light"}}"#,
        )
        .unwrap();
        let s = load_settings(dir.path());
        assert_eq!(s.appearance.theme, "light");
        assert_eq!(s.editor.font_size, 16); // 누락 필드는 기본값
        assert!(s.sync.auto);
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("\"autoSaveDelayMs\""));
        assert!(json.contains("\"fontFamily\""));
        assert!(json.contains("\"htmlViewer\""));
        assert!(json.contains("\"intervalMinutes\""));
        assert!(json.contains("\"confirmDelete\""));
        assert!(json.contains("\"customColors\""));
    }

    #[test]
    fn custom_colors_roundtrip_and_default_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_settings(dir.path())
            .appearance
            .custom_colors
            .is_empty());

        let mut s = Settings::default();
        s.appearance.theme = "pink".into();
        s.appearance
            .custom_colors
            .insert("accent".into(), "#ff66aa".into());
        save_settings(dir.path(), &s).unwrap();

        let loaded = load_settings(dir.path());
        assert_eq!(loaded, s);
        assert_eq!(
            loaded.appearance.custom_colors.get("accent").unwrap(),
            "#ff66aa"
        );
    }

    #[test]
    fn line_numbers_default_off_and_roundtrip() {
        // 기본값은 꺼짐
        assert!(!Settings::default().editor.show_line_numbers);

        // 켠 뒤 저장·복원이 유지된다
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.editor.show_line_numbers = true;
        save_settings(dir.path(), &s).unwrap();
        assert!(load_settings(dir.path()).editor.show_line_numbers);

        // camelCase 키로 직렬화된다 (프론트 Settings.editor.showLineNumbers 와 매핑)
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"showLineNumbers\":true"));
    }

    #[test]
    fn backlinks_default_off_and_roundtrip() {
        // 기본값은 숨김
        assert!(!Settings::default().editor.show_backlinks);

        // 켠 뒤 저장·복원이 유지된다
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.editor.show_backlinks = true;
        save_settings(dir.path(), &s).unwrap();
        assert!(load_settings(dir.path()).editor.show_backlinks);

        // camelCase 키로 직렬화된다 (프론트 Settings.editor.showBacklinks 와 매핑)
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"showBacklinks\":true"));
    }

    #[test]
    fn old_settings_without_backlinks_default_off() {
        // 백링크 필드가 없던 기존 settings.json 은 기본값(숨김)으로 읽힌다.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"editor":{"fontSize":18}}"#,
        )
        .unwrap();
        let s = load_settings(dir.path());
        assert!(!s.editor.show_backlinks);
    }

    #[test]
    fn old_settings_without_line_numbers_default_off() {
        // 줄 번호 필드가 없던 기존 settings.json 은 기본값(꺼짐)으로 읽힌다.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"editor":{"fontSize":18}}"#,
        )
        .unwrap();
        let s = load_settings(dir.path());
        assert_eq!(s.editor.font_size, 18);
        assert!(!s.editor.show_line_numbers);
    }

    #[test]
    fn terminal_defaults_present_and_roundtrips() {
        let s = Settings::default();
        assert!(!s.terminal.external.is_empty());
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.terminal.external, s.terminal.external);
    }

    #[test]
    fn legacy_settings_without_terminal_still_load() {
        // 과거 파일에 terminal 섹션이 없어도 기본값으로 로드돼야 한다.
        let legacy = r#"{"appearance":{},"editor":{},"sync":{},"htmlViewer":{},"files":{}}"#;
        let s: Settings = serde_json::from_str(legacy).unwrap_or_default();
        assert!(!s.terminal.external.is_empty());
    }

    #[test]
    fn partial_settings_get_defaults() {
        // 일부 섹션만 있는 settings.json은 나머지를 기본값으로 읽어야 한다.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"appearance":{"theme":"dark"},"editor":{"fontSize":18}}"#,
        )
        .unwrap();
        let s = load_settings(dir.path());
        assert_eq!(s.appearance.theme, "dark");
        assert_eq!(s.editor.font_size, 18);
        assert_eq!(s.sync, SyncSettings::default());
    }
}
