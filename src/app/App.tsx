import { useEffect } from "react";
import { ipc } from "../ipc/ipc";
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

  // 전역 단축키: Cmd+, 설정 · Cmd+Shift+N 새 창
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === ",") {
        e.preventDefault();
        const s = useSettings.getState();
        s.showSettings ? s.closeSettings() : s.openSettings();
      } else if (e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void ipc.newWindow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 테마 적용: data-theme 속성 + 시스템 테마 변화 추적 (FR-5.3)
  // 네이티브 창(타이틀바)도 같은 테마를 따르도록 동기화한다
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute("data-theme", effectiveTheme(theme));
    apply();
    void ipc.setWindowTheme(theme === "system" ? null : theme).catch(() => undefined);
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
