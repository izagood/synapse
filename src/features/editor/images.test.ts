import { describe, expect, it } from "vitest";
import { fileToBase64, pastedImageName } from "./images";

describe("editor images", () => {
  it("pastedImageName generates a random name with the right extension", () => {
    expect(pastedImageName("image/png")).toMatch(/^image-[a-z0-9]+-[a-z0-9]+\.png$/);
    expect(pastedImageName("image/jpeg")).toMatch(/\.jpg$/);
    expect(pastedImageName("")).toMatch(/\.png$/);
    expect(pastedImageName("image/png")).not.toBe(pastedImageName("image/png"));
  });

  it("fileToBase64 encodes bytes losslessly (청크 경계 포함)", async () => {
    const bytes = new Uint8Array(70000); // 0x8000 청크 경계를 넘는 크기
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const b64 = await fileToBase64(new Blob([bytes]));
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
