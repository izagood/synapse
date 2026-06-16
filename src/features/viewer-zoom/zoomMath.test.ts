import { describe, expect, it } from "vitest";
import {
  clampScale,
  clampTranslate,
  distance,
  IDENTITY,
  isZoomed,
  MAX_SCALE,
  MIN_SCALE,
  midpoint,
  zoomAt,
} from "./zoomMath";

describe("clampScale", () => {
  it("min/max 범위로 제한한다", () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });
});

describe("zoomAt", () => {
  it("앵커 지점이 확대 후에도 화면상 같은 위치에 머문다", () => {
    // 콘텐츠 좌표 = (스크린 - translate) / scale 이 불변이어야 한다.
    const start = { scale: 1, x: 0, y: 0 };
    const ax = 200;
    const ay = 150;
    const contentBefore = { x: (ax - start.x) / start.scale, y: (ay - start.y) / start.scale };
    const next = zoomAt(start, 2, ax, ay);
    const contentAfter = { x: (ax - next.x) / next.scale, y: (ay - next.y) / next.scale };
    expect(next.scale).toBe(2);
    expect(contentAfter.x).toBeCloseTo(contentBefore.x, 6);
    expect(contentAfter.y).toBeCloseTo(contentBefore.y, 6);
  });

  it("scale 을 MAX 이상으로 올리지 않는다", () => {
    const next = zoomAt({ scale: MAX_SCALE, x: 0, y: 0 }, 4, 0, 0);
    expect(next.scale).toBe(MAX_SCALE);
  });

  it("MIN 아래로 내리지 않는다", () => {
    const next = zoomAt({ scale: 1, x: 0, y: 0 }, 0.1, 0, 0);
    expect(next.scale).toBe(MIN_SCALE);
  });
});

describe("clampTranslate", () => {
  it("scale 1 이면 translate 를 0(가운데)으로 강제한다", () => {
    const r = clampTranslate({ scale: 1, x: 123, y: -45 }, 400, 300);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("확대 상태에서 콘텐츠가 뷰포트를 벗어나 거터가 생기지 않게 막는다", () => {
    const vw = 400;
    const vh = 300;
    // scale 2 → translate 허용 범위 [vw*(1-2), 0] = [-400, 0]
    expect(clampTranslate({ scale: 2, x: 50, y: 10 }, vw, vh).x).toBe(0);
    expect(clampTranslate({ scale: 2, x: -9999, y: 0 }, vw, vh).x).toBe(-vw);
    expect(clampTranslate({ scale: 2, x: -200, y: 0 }, vw, vh).x).toBe(-200);
  });
});

describe("distance / midpoint", () => {
  it("두 점 사이 거리와 중점", () => {
    expect(distance(0, 0, 3, 4)).toBe(5);
    expect(midpoint(0, 0, 10, 20)).toEqual({ x: 5, y: 10 });
  });
});

describe("isZoomed", () => {
  it("scale 1 이면 false, 확대되면 true", () => {
    expect(isZoomed(IDENTITY)).toBe(false);
    expect(isZoomed({ scale: 1.5, x: 0, y: 0 })).toBe(true);
  });
});
