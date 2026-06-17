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

/// Claude 에이전트 설정 (2-D 배포 정책 대응). API 키 자체는 settings.json 평문에
/// 두지 않고 OS 키체인에 보관하므로 여기에는 들어가지 않는다 — 인증 방식과
/// 모델/권한 선택만 둔다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// "subscription"(기본, claude CLI 구독 로그인) | "apiKey"(ANTHROPIC_API_KEY 주입)
    pub auth_mode: String,
    /// 빈 문자열이면 CLI 기본 모델을 따른다. 예: "claude-sonnet-4-5"
    pub model: String,
    /// claude `--permission-mode` 값. 빈 문자열이면 CLI 기본(읽기 전용 도구만).
    pub permission_mode: String,
}

impl Default for AgentSettings {
    fn default() -> Self {
        AgentSettings {
            auth_mode: "subscription".into(),
            model: String::new(),
            permission_mode: String::new(),
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
    pub agent: AgentSettings,
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
    fn agent_defaults_to_subscription_mode() {
        let s = Settings::default();
        assert_eq!(s.agent.auth_mode, "subscription");
        assert_eq!(s.agent.model, "");
        assert_eq!(s.agent.permission_mode, "");
    }

    #[test]
    fn agent_section_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.agent.auth_mode = "apiKey".into();
        s.agent.model = "claude-sonnet-4-5".into();
        s.agent.permission_mode = "acceptEdits".into();
        save_settings(dir.path(), &s).unwrap();
        assert_eq!(load_settings(dir.path()), s);

        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"agent\""));
        assert!(json.contains("\"authMode\":\"apiKey\""));
        assert!(json.contains("\"permissionMode\":\"acceptEdits\""));
    }

    #[test]
    fn old_settings_without_agent_section_get_defaults() {
        // 기존(2-D 이전) settings.json에는 agent 섹션이 없다 — 기본값으로 읽혀야 한다.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"appearance":{"theme":"dark"},"editor":{"fontSize":18}}"#,
        )
        .unwrap();
        let s = load_settings(dir.path());
        assert_eq!(s.appearance.theme, "dark");
        assert_eq!(s.editor.font_size, 18);
        assert_eq!(s.agent, AgentSettings::default());
        assert_eq!(s.agent.auth_mode, "subscription");
    }
}
