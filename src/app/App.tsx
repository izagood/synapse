import { useEffect } from "react";
import { useWorkspace } from "../stores/workspace";
import { effectiveTheme, useSettings } from "../stores/settings";
import { StartScreen } from "../features/workspace/StartScreen";
import { WorkspaceView } from "../features/workspace/WorkspaceView";
import { SettingsModal } from "../features/settings/SettingsModal";

export default function App() {
  const root = useWorkspace((s) => s.root);
  const initWorkspace = useWorkspace((s) => s.init);
  const initSettings = useSettings((s) => s.init);
  const theme = useSettings((s) => s.settings.appearance.theme);
  const fontSize = useSettings((s) => s.settings.editor.fontSize);
  const fontFamily = useSettings((s) => s.settings.editor.fontFamily);

  useEffect(() => {
    void initWorkspace();
    void initSettings();
  }, [initWorkspace, initSettings]);

  // Cmd/Ctrl+,: 설정 (F3) — 시작 화면에서도 동작하도록 앱 전역에 둔다
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        const s = useSettings.getState();
        s.showSettings ? s.closeSettings() : s.openSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 테마 적용: data-theme 속성 + 시스템 테마 변화 추적 (FR-5.3)
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute("data-theme", effectiveTheme(theme));
    apply();
    if (theme === "system" && "matchMedia" in window) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--editor-font-size", `${fontSize}px`);
    style.setProperty("--editor-font-family", fontFamily || "system-ui");
  }, [fontSize, fontFamily]);

  return (
    <>
      {root ? <WorkspaceView /> : <StartScreen />}
      <SettingsModal />
    </>
  );
}
