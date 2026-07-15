import { useEffect } from "react";
import { ipc } from "../ipc/ipc";
import { useWorkspace } from "../stores/workspace";
import { useSettings } from "../stores/settings";
import { applyTheme, nativeWindowTheme } from "../features/theme/theme";
import { StartScreen } from "../features/workspace/StartScreen";
import { WorkspaceView } from "../features/workspace/WorkspaceView";
import { installFileWatch } from "../features/workspace/fileWatch";
import { SettingsModal } from "../features/settings/SettingsModal";
import { ShortcutCheatsheet } from "../features/shortcuts/ShortcutCheatsheet";
import { UpdateToast } from "../features/update/UpdateToast";
import { isShortcut } from "../shared/shortcuts";

export default function App() {
  const root = useWorkspace((s) => s.root);
  const initWorkspace = useWorkspace((s) => s.init);
  const initSettings = useSettings((s) => s.init);
  const theme = useSettings((s) => s.settings.appearance.theme);
  const customColors = useSettings((s) => s.settings.appearance.customColors);
  const fontSize = useSettings((s) => s.settings.editor.fontSize);
  const fontFamily = useSettings((s) => s.settings.editor.fontFamily);

  useEffect(() => {
    void initWorkspace();
    void initSettings();
  }, [initWorkspace, initSettings]);

  // 외부 파일 변경 시 수동 새로고침 없이 자동 reload (워처 + 포커스 복귀)
  useEffect(() => installFileWatch(), []);

  // 전역 단축키: 설정 토글 · 새 창 · 단축키 치트시트 (정의는 shared/shortcuts 단일 출처)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isShortcut(e, "settings.toggle")) {
        e.preventDefault();
        const s = useSettings.getState();
        if (s.showSettings) {
          s.closeSettings();
        } else {
          s.openSettings();
        }
      } else if (isShortcut(e, "window.new")) {
        e.preventDefault();
        void ipc.newWindow();
      } else if (isShortcut(e, "help.cheatsheet")) {
        e.preventDefault();
        useSettings.getState().toggleShortcuts();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 테마 적용: data-theme 속성 + 커스텀 색상 오버라이드 + 시스템 테마 변화 추적 (FR-5.3)
  // 네이티브 창(타이틀바)도 같은 테마를 따르도록 동기화한다
  useEffect(() => {
    const apply = () => applyTheme(document.documentElement, theme, customColors);
    apply();
    void ipc.setWindowTheme(nativeWindowTheme(theme)).catch(() => undefined);
    if (theme === "system" && "matchMedia" in window) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme, customColors]);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--editor-font-size", `${fontSize}px`);
    style.setProperty("--editor-font-family", fontFamily || "system-ui");
  }, [fontSize, fontFamily]);

  return (
    <>
      {root ? <WorkspaceView /> : <StartScreen />}
      <SettingsModal />
      <ShortcutCheatsheet />
      {/* 시작 화면에서는 StartUpdateBar(카드 푸터)가 업데이트를 알린다 */}
      {root && <UpdateToast />}
    </>
  );
}
