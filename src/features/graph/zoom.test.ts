import { describe, expect, it } from "vitest";
import { applyZoom, wheelZoomFactor } from "./zoom";

describe("wheelZoomFactor", () => {
  it("트랙패드 미세 델타(±3px)에는 완만한 배율을 준다", () => {
    const f = wheelZoomFactor({ deltaY: -3, deltaMode: 0, ctrlKey: false });
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThan(1.02);
  });

  it("트랙패드 제스처 전체(-90px 누적)로도 폭주하지 않는다", () => {
    let k = 1;
    for (let i = 0; i < 30; i++) {
      k *= wheelZoomFactor({ deltaY: -3, deltaMode: 0, ctrlKey: false });
    }
    expect(k).toBeGreaterThan(1.05);
    expect(k).toBeLessThan(1.25);
  });

  it("마우스 휠 한 칸(-120px)은 체감되는 스텝을 준다", () => {
    const f = wheelZoomFactor({ deltaY: -120, deltaMode: 0, ctrlKey: false });
    expect(f).toBeGreaterThan(1.1);
    expect(f).toBeLessThan(1.3);
  });

  it("라인 단위(deltaMode=1) 휠도 픽셀 단위와 비슷한 스텝으로 환산한다", () => {
    const f = wheelZoomFactor({ deltaY: -1, deltaMode: 1, ctrlKey: false });
    expect(f).toBeGreaterThan(1.02);
    expect(f).toBeLessThan(1.1);
  });

  it("핀치(ctrlKey)는 일반 스크롤보다 민감하되 이벤트당 10% 미만", () => {
    const pinch = wheelZoomFactor({ deltaY: -5, deltaMode: 0, ctrlKey: true });
    const scroll = wheelZoomFactor({ deltaY: -5, deltaMode: 0, ctrlKey: false });
    expect(pinch).toBeGreaterThan(scroll);
    expect(pinch).toBeLessThan(1.1);
  });

  it("확대/축소가 대칭이다: f(d) * f(-d) = 1", () => {
    const zoomIn = wheelZoomFactor({ deltaY: -30, deltaMode: 0, ctrlKey: false });
    const zoomOut = wheelZoomFactor({ deltaY: 30, deltaMode: 0, ctrlKey: false });
    expect(zoomIn * zoomOut).toBeCloseTo(1, 10);
  });
});

describe("applyZoom", () => {
  const view = { k: 2, tx: 100, ty: 50 };

  it("앵커(커서) 아래의 월드 좌표가 줌 후에도 같은 화면 위치에 남는다", () => {
    const [vx, vy] = [450, 300];
    // 화면(vx,vy)에 보이는 월드 좌표
    const wx = (vx - view.tx) / view.k;
    const wy = (vy - view.ty) / view.k;
    const next = applyZoom(view, vx, vy, 1.3, 0.4, 5);
    expect(wx * next.k + next.tx).toBeCloseTo(vx, 9);
    expect(wy * next.k + next.ty).toBeCloseTo(vy, 9);
  });

  it("배율을 min/max 범위로 클램프한다", () => {
    expect(applyZoom(view, 0, 0, 100, 0.4, 5).k).toBe(5);
    expect(applyZoom(view, 0, 0, 0.0001, 0.4, 5).k).toBe(0.4);
  });
});
