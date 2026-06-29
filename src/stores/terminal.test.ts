// @vitest-environment jsdom
// 도크 상한이 window.innerHeight에 의존하므로 jsdom(window 제공) 환경에서 돌린다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useTerminal,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_EDITOR_GAP,
  terminalMaxHeight,
} from "./terminal";

const reset = () =>
  useTerminal.setState({ terminals: [], activeId: null, visible: false });

/** 테스트 동안 window.innerHeight를 고정한다(원복은 afterEach). */
function stubViewportHeight(px: number) {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: px,
  });
}

describe("terminal store", () => {
  beforeEach(reset);
  // jsdom 기본 innerHeight(768)로 원복해 테스트 간 누수 방지.
  afterEach(() => stubViewportHeight(768));

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

  it("setHeight: 하한은 MIN, 기본값은 그대로 통과", () => {
    useTerminal.getState().setHeight(1);
    expect(useTerminal.getState().heightPx).toBe(TERMINAL_MIN_HEIGHT);
    useTerminal.getState().setHeight(TERMINAL_DEFAULT_HEIGHT);
    expect(useTerminal.getState().heightPx).toBe(TERMINAL_DEFAULT_HEIGHT);
  });

  it("setHeight: 상한은 뷰포트 비례(고정 800 아님) — 큰 화면일수록 더 높이 허용", () => {
    // 큰 모니터: 1600px → 상한 1440까지 커진다(과거 800 고정 상한 버그 회귀 방지).
    stubViewportHeight(1600);
    expect(terminalMaxHeight()).toBe(1600 - TERMINAL_MIN_EDITOR_GAP);
    useTerminal.getState().setHeight(10_000);
    expect(useTerminal.getState().heightPx).toBe(1440);
    expect(useTerminal.getState().heightPx).toBeGreaterThan(800);

    // 작은 화면: 600px → 에디터 영역(GAP)을 남기고 440에서 멈춘다.
    stubViewportHeight(600);
    useTerminal.getState().setHeight(10_000);
    expect(useTerminal.getState().heightPx).toBe(600 - TERMINAL_MIN_EDITOR_GAP);
  });

  it("terminalMaxHeight: 극단적으로 작은 뷰포트에서도 MIN 이상 보장", () => {
    stubViewportHeight(100);
    expect(terminalMaxHeight()).toBe(TERMINAL_MIN_HEIGHT);
  });
});
