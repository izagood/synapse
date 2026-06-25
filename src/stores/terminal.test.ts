import { beforeEach, describe, expect, it } from "vitest";
import {
  useTerminal,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MAX_HEIGHT,
} from "./terminal";

const reset = () =>
  useTerminal.setState({ terminals: [], activeId: null, visible: false });

describe("terminal store", () => {
  beforeEach(reset);

  it("newTerminal: 추가하고 활성화 + 패널 표시, n은 매번 증가", () => {
    useTerminal.getState().newTerminal();
    useTerminal.getState().newTerminal();
    const s = useTerminal.getState();
    expect(s.terminals).toHaveLength(2);
    expect(s.visible).toBe(true);
    expect(s.activeId).toBe(s.terminals[1].id);
    // 일련번호는 서로 다르고 증가한다(닫아도 재사용 안 함)
    expect(s.terminals[0].n).toBeLessThan(s.terminals[1].n);
    expect(s.terminals[0].id).not.toBe(s.terminals[1].id);
  });

  it("closeTerminal: 활성 탭을 닫으면 인접 탭으로 활성 이동", () => {
    const t = useTerminal.getState();
    t.newTerminal();
    t.newTerminal();
    t.newTerminal();
    const [a, b, c] = useTerminal.getState().terminals;
    useTerminal.getState().setActive(b.id);
    useTerminal.getState().closeTerminal(b.id);
    const s = useTerminal.getState();
    expect(s.terminals.map((x) => x.id)).toEqual([a.id, c.id]);
    // b(인덱스1)를 닫으면 그 자리의 c가 활성
    expect(s.activeId).toBe(c.id);
  });

  it("closeTerminal: 마지막 터미널을 닫으면 패널 숨김 + 활성 null", () => {
    useTerminal.getState().newTerminal();
    const only = useTerminal.getState().terminals[0];
    useTerminal.getState().closeTerminal(only.id);
    const s = useTerminal.getState();
    expect(s.terminals).toHaveLength(0);
    expect(s.activeId).toBeNull();
    expect(s.visible).toBe(false);
  });

  it("toggle: 터미널이 없으면 하나 만들어 켜고, 있으면 visible만 뒤집는다", () => {
    useTerminal.getState().toggle();
    let s = useTerminal.getState();
    expect(s.terminals).toHaveLength(1);
    expect(s.visible).toBe(true);

    useTerminal.getState().toggle(); // 끈다(세션 유지)
    s = useTerminal.getState();
    expect(s.visible).toBe(false);
    expect(s.terminals).toHaveLength(1); // 목록은 유지

    useTerminal.getState().toggle(); // 다시 켠다
    expect(useTerminal.getState().visible).toBe(true);
  });

  it("setHeight: 범위를 벗어나면 클램프", () => {
    useTerminal.getState().setHeight(10_000);
    expect(useTerminal.getState().heightPx).toBe(TERMINAL_MAX_HEIGHT);
    useTerminal.getState().setHeight(1);
    expect(useTerminal.getState().heightPx).toBe(TERMINAL_MIN_HEIGHT);
    useTerminal.getState().setHeight(TERMINAL_DEFAULT_HEIGHT);
    expect(useTerminal.getState().heightPx).toBe(TERMINAL_DEFAULT_HEIGHT);
  });
});
