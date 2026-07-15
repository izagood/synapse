import { create } from "zustand";
import type { TranslationKey } from "../../i18n";
import type { ShortcutCategory } from "../../shared/shortcuts";

// 커맨드(실행 가능한 액션)의 단일 출처. 단축키 디스패처·커맨드 팔레트가
// 모두 여기 등록된 커맨드를 참조한다. id 는 ShortcutDef.id 와 같은
// 네임스페이스를 쓴다(예: "tab.closeOthers") — 단축키 정의와 커맨드가
// id 로 자연 결합되고, 팔레트는 SHORTCUTS 에서 키 라벨을 역조회한다.
//
// 등록은 두 갈래다:
// - 정적: zustand 스토어만으로 실행 가능한 커맨드 (staticCommands.ts, 앱 시작 시 1회)
// - 동적: 컴포넌트 로컬 state 가 필요한 커맨드 — 컴포넌트가
//   useEffect(() => registerCommand(...), []) 로 마운트 동안만 등록한다.
export interface CommandDef {
  id: string;
  titleKey: TranslationKey;
  category: ShortcutCategory;
  run(): void | Promise<void>;
  /** false 면 디스패처는 preventDefault 없이 통과시키고 팔레트는 숨긴다 */
  enabled?(): boolean;
  /** 키보드 전용 커맨드 (tab.goTo1~9 등) — 팔레트 목록에서 제외 */
  hideFromPalette?: boolean;
}

interface RegistryState {
  commands: Record<string, CommandDef>;
}

export const useCommandRegistry = create<RegistryState>(() => ({ commands: {} }));

/** 커맨드를 등록하고 해제 함수를 반환한다 (useEffect cleanup에 그대로 사용) */
export function registerCommand(def: CommandDef): () => void {
  useCommandRegistry.setState((s) => ({ commands: { ...s.commands, [def.id]: def } }));
  return () => {
    useCommandRegistry.setState((s) => {
      // 이후 다른 def 가 같은 id 로 덮어썼다면 건드리지 않는다
      if (s.commands[def.id] !== def) return s;
      const commands = { ...s.commands };
      delete commands[def.id];
      return { commands };
    });
  };
}

export function getCommand(id: string): CommandDef | undefined {
  return useCommandRegistry.getState().commands[id];
}

/** 실행했으면 true. 미등록이거나 enabled()가 false 면 false (디스패처가 키를 통과시킴) */
export function executeCommand(id: string): boolean {
  const cmd = getCommand(id);
  if (!cmd || (cmd.enabled && !cmd.enabled())) return false;
  void Promise.resolve(cmd.run()).catch((e) => {
    console.error(`command failed: ${id}`, e);
  });
  return true;
}
