import { registerCommand, type CommandDef } from "./registry";
import { useWorkspace } from "../../stores/workspace";
import { useTerminal } from "../../stores/terminal";
import { useSettings } from "../../stores/settings";
import { ipc } from "../../ipc/ipc";
import { createTargetDir } from "../workspace/fileTreeUtils";

// zustand 스토어만으로 실행 가능한 커맨드들 — 앱 시작 시 1회 정적 등록한다.
// 컴포넌트 로컬 state 가 필요한 커맨드(그래프·검색·퀵오픈·사이드바·팔레트
// 토글)는 해당 컴포넌트가 동적 등록한다 (WorkspaceView 참고).

const ws = () => useWorkspace.getState();

/** 새 파일 생성 대상 디렉토리 — 활성 노트의 폴더 (WorkspaceView 와 동일 규칙) */
function targetDir(): string {
  const { activePath, root } = ws();
  return createTargetDir(activePath, root ?? "");
}

/** 터미널 도크에 포커스가 있고 활성 터미널이 있는가 (⌘W 분기용) */
function terminalFocused(): boolean {
  const term = useTerminal.getState();
  return term.visible && !!term.activeId && !!document.activeElement?.closest(".terminal-dock");
}

const defs: CommandDef[] = [
  {
    id: "tab.close",
    titleKey: "tabs.close",
    category: "file",
    // 탭도 터미널 포커스도 없으면 disabled — 디스패처가 ⌘W 를 통과시켜
    // OS 기본 동작(마지막 탭에서 창 닫기)이 그대로 동작한다.
    enabled: () => terminalFocused() || ws().activePath !== null,
    run: () => {
      // 포커스가 터미널 도크 안이면 노트가 아니라 활성 터미널을 닫는다 (VS Code).
      if (terminalFocused()) {
        const term = useTerminal.getState();
        term.closeTerminal(term.activeId!);
        return;
      }
      const { activePath, closeTab } = ws();
      if (activePath) return closeTab(activePath);
    },
  },
  {
    id: "tab.closeOthers",
    titleKey: "tabs.closeOthers",
    category: "file",
    enabled: () => ws().tabs.length > 1,
    run: () => {
      const { activePath, closeOtherTabs } = ws();
      if (activePath) return closeOtherTabs(activePath);
    },
  },
  {
    id: "tab.closeRight",
    titleKey: "tabs.closeRight",
    category: "file",
    enabled: () => {
      const { tabs, activePath } = ws();
      const idx = tabs.findIndex((t) => t.path === activePath);
      return idx !== -1 && idx < tabs.length - 1;
    },
    run: () => {
      const { activePath, closeTabsToRight } = ws();
      if (activePath) return closeTabsToRight(activePath);
    },
  },
  {
    id: "tab.closeAll",
    titleKey: "tabs.closeAll",
    category: "file",
    enabled: () => ws().tabs.length > 0,
    run: () => ws().closeAllTabs(),
  },
  {
    id: "tab.reopen",
    titleKey: "shortcuts.desc.reopenTab",
    category: "file",
    enabled: () => ws().recentlyClosed.length > 0,
    run: () => ws().reopenClosedTab(),
  },
  {
    id: "tab.next",
    titleKey: "shortcuts.desc.nextTab",
    category: "navigation",
    enabled: () => ws().tabs.length > 1,
    run: () => ws().nextTab(),
  },
  {
    id: "tab.prev",
    titleKey: "shortcuts.desc.prevTab",
    category: "navigation",
    enabled: () => ws().tabs.length > 1,
    run: () => ws().prevTab(),
  },
  // n번째 탭으로 — 키보드 전용(팔레트에 9줄 노이즈 방지)
  ...Array.from(
    { length: 9 },
    (_, i): CommandDef => ({
      id: `tab.goTo${i + 1}`,
      titleKey: "shortcuts.desc.goToTab",
      category: "navigation",
      hideFromPalette: true,
      enabled: () => ws().tabs.length > 0,
      run: () => ws().goToTab(i + 1),
    }),
  ),
  {
    id: "file.save",
    titleKey: "shortcuts.desc.save",
    category: "file",
    enabled: () => ws().activePath !== null,
    run: () => ws().saveActive(),
  },
  {
    id: "file.newNote",
    titleKey: "shortcuts.desc.newNote",
    category: "file",
    run: () => ws().createNote(targetDir()),
  },
  {
    id: "file.newDrawing",
    titleKey: "shortcuts.desc.newDrawing",
    category: "file",
    run: () => ws().createDrawing(targetDir()),
  },
  {
    id: "file.newDiagram",
    titleKey: "shortcuts.desc.newDiagram",
    category: "file",
    run: () => ws().createDrawioFile(targetDir()),
  },
  {
    id: "view.toggleTerminal",
    titleKey: "shortcuts.desc.toggleTerminal",
    category: "view",
    run: () => useTerminal.getState().toggle(),
  },
  {
    id: "view.toggleBacklinks",
    titleKey: "backlinks.toggle",
    category: "view",
    // 설정(editor.showBacklinks)을 뒤집어 저장한다 — 설정 모달 체크박스와 동일 상태
    run: () => {
      const s = useSettings.getState();
      const editor = s.settings.editor;
      return s.update({ editor: { ...editor, showBacklinks: !editor.showBacklinks } });
    },
  },
  {
    id: "window.new",
    titleKey: "shortcuts.desc.newWindow",
    category: "general",
    run: () => void ipc.newWindow(),
  },
  {
    id: "settings.toggle",
    titleKey: "shortcuts.desc.settingsToggle",
    category: "general",
    run: () => {
      const s = useSettings.getState();
      if (s.showSettings) s.closeSettings();
      else s.openSettings();
    },
  },
  {
    id: "help.cheatsheet",
    titleKey: "shortcuts.desc.cheatsheet",
    category: "general",
    run: () => useSettings.getState().toggleShortcuts(),
  },
];

/** 정적 커맨드 일괄 등록 — 같은 def 로 다시 등록하므로 중복 호출은 무해하다 */
export function registerStaticCommands(): void {
  for (const def of defs) registerCommand(def);
}
