//! 앱 전역 설정 (FR-5). 워크스페이스 폴더가 아닌 단 한 곳에만 저장한다.
//! 필드 단위 serde 기본값이라 일부만 적힌(또는 과거 버전의) 파일도 안전하게 읽힌다.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub theme: String, // "system" | "light" | "dark"
    pub language: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            theme: "system".into(),
            language: "ko".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    pub font_family: String,
    pub font_size: u32,
    pub auto_save_delay_ms: u64,
    pub assets_folder: String,
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            font_family: "system-ui".into(),
            font_size: 16,
            auto_save_delay_ms: 1000,
            assets_folder: "assets".into(),
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

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub appearance: Appearance,
    pub editor: EditorSettings,
    pub sync: SyncSettings,
    pub html_viewer: HtmlViewerSettings,
    pub files: FilesSettings,
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
    }
}
