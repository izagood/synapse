import { useEffect } from "react";
import { ipc } from "../ipc/ipc";
import { useWorkspace } from "../stores/workspace";
import { useSettings } from "../stores/settings";
import { registerStaticCommands } from "../features/commands/staticCommands";
import { useShortcutDispatcher } from "../features/commands/useShortcutDispatcher";
import { applyTheme, nativeWindowTheme } from "../features/theme/theme";
import { basename } from "../shared/pathUtils";
import { StartScreen } from "../features/workspace/StartScreen";
import { WorkspaceView } from "../features/workspace/WorkspaceView";
import { installFileWatch } from "../features/workspace/fileWatch";
import { SettingsModal } from "../features/settings/SettingsModal";
import { ShortcutCheatsheet } from "../features/shortcuts/ShortcutCheatsheet";
import { UpdateToast } from "../features/update/UpdateToast";

// 스토어 기반 커맨드는 모듈 로드 시 1회 등록 (컴포넌트 로컬 state 커맨드는
// WorkspaceView 가 마운트 동안 동적 등록한다)
registerStaticCommands();

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

  // 창 제목을 열린 폴더명으로 동기화 — macOS 는 hiddenTitle 로 숨겨져 있지만
  // Mission Control 등에, Windows/Linux 는 네이티브 타이틀바에 그대로 쓰인다
  useEffect(() => {
    const title = root ? `${basename(root)} — Synapse` : "Synapse";
    void ipc.setWindowTitle(title).catch(() => undefined);
  }, [root]);

  // 전역 단축키: 정의(shared/shortcuts)와 실행(커맨드 레지스트리)을 잇는
  // keydown 리스너는 앱 전체에 이 디스패처 하나뿐이다
  useShortcutDispatcher();

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
