import { describe, it, expect } from "vitest";
import { IDENTITY, worldToScreen, screenToWorld, zoomAround } from "./camera";

describe("camera", () => {
  it("worldToScreen/screenToWorld 가 서로 역변환", () => {
    const cam = { k: 2, tx: 30, ty: -10 };
    const s = worldToScreen(cam, 100, 50);
    const w = screenToWorld(cam, s.x, s.y);
    expect(w.x).toBeCloseTo(100);
    expect(w.y).toBeCloseTo(50);
  });
  it("zoomAround 는 커서 아래 월드 좌표를 고정한다", () => {
    const before = screenToWorld(IDENTITY, 200, 150);
    const cam = zoomAround(IDENTITY, 200, 150, 1.5, 0.4, 5);
    const after = screenToWorld(cam, 200, 150);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(cam.k).toBeCloseTo(1.5);
  });
  it("zoomAround 는 min/max 로 클램프", () => {
    expect(zoomAround(IDENTITY, 0, 0, 100, 0.4, 5).k).toBe(5);
    expect(zoomAround(IDENTITY, 0, 0, 0.001, 0.4, 5).k).toBe(0.4);
  });
});
