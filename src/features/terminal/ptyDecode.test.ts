import { describe, expect, it } from "vitest";
import { decodeBase64 } from "./ptyDecode";

describe("decodeBase64 (PTY 출력 디코드)", () => {
  it("ASCII 텍스트를 바이트로 푼다", () => {
    // "hi\n" -> base64
    const bytes = decodeBase64("aGkK");
    expect(Array.from(bytes)).toEqual([0x68, 0x69, 0x0a]);
  });

  it("ANSI 이스케이프 시퀀스의 ESC(0x1b) 바이트를 보존한다", () => {
    // "\x1b[31m" (빨강) -> base64
    const bytes = decodeBase64("G1szMW0=");
    expect(bytes[0]).toBe(0x1b);
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
  });

  it("UTF-8 멀티바이트(한글)도 바이트 그대로 보존한다", () => {
    // "가" = EA B0 80 -> base64
    const bytes = decodeBase64("6rCA");
    expect(Array.from(bytes)).toEqual([0xea, 0xb0, 0x80]);
  });

  it("빈 문자열은 빈 배열", () => {
    expect(decodeBase64("").length).toBe(0);
  });
});
