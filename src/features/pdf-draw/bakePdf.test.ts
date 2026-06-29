import { describe, it, expect } from "vitest";
import { hexToRgb01, bytesToBase64 } from "./bakePdf";

describe("hexToRgb01", () => {
  it("6자리 hex 를 0..1 로 변환", () => {
    expect(hexToRgb01("#ffffff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgb01("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    const red = hexToRgb01("#e02424");
    expect(red.r).toBeCloseTo(224 / 255);
    expect(red.g).toBeCloseTo(36 / 255);
  });

  it("3자리 hex 도 처리", () => {
    expect(hexToRgb01("#fff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgb01("#f00")).toEqual({ r: 1, g: 0, b: 0 });
  });

  it("잘못된 입력은 검정", () => {
    expect(hexToRgb01("nope")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb01("#zzzzzz")).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("bytesToBase64", () => {
  it("바이트를 base64 로 인코딩(라운드트립)", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe("SGVsbG8=");
    expect(atob(b64)).toBe("Hello");
  });

  it("빈 배열", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });
});
