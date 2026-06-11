import { describe, expect, it } from "vitest";
import { resolveInternalLink } from "./internalLink";

const ROOT = "/vault";
const CURRENT = "/vault/rust/03-트레잇.md";

describe("resolveInternalLink", () => {
  it("같은 폴더의 상대 경로를 해석한다", () => {
    expect(resolveInternalLink("00-목차.md", CURRENT, ROOT)).toBe(
      "/vault/rust/00-목차.md",
    );
    expect(resolveInternalLink("./00-목차.md", CURRENT, ROOT)).toBe(
      "/vault/rust/00-목차.md",
    );
  });

  it("상위 폴더(..)와 하위 폴더 경로를 해석한다", () => {
    expect(resolveInternalLink("../README.md", CURRENT, ROOT)).toBe(
      "/vault/README.md",
    );
    expect(resolveInternalLink("../docs/spec.md", CURRENT, ROOT)).toBe(
      "/vault/docs/spec.md",
    );
    expect(resolveInternalLink("examples/hello.md", CURRENT, ROOT)).toBe(
      "/vault/rust/examples/hello.md",
    );
  });

  it("선행 /는 vault 루트 기준으로 해석한다", () => {
    expect(resolveInternalLink("/docs/spec.md", CURRENT, ROOT)).toBe(
      "/vault/docs/spec.md",
    );
  });

  it("앵커·쿼리는 떼고 파일 경로만 남긴다", () => {
    expect(resolveInternalLink("00-목차.md#섹션", CURRENT, ROOT)).toBe(
      "/vault/rust/00-목차.md",
    );
    expect(resolveInternalLink("00-목차.md?x=1", CURRENT, ROOT)).toBe(
      "/vault/rust/00-목차.md",
    );
  });

  it("퍼센트 인코딩된 한글 파일명을 복원한다", () => {
    expect(
      resolveInternalLink("00-%EB%AA%A9%EC%B0%A8.md", CURRENT, ROOT),
    ).toBe("/vault/rust/00-목차.md");
  });

  it("외부 링크와 문서 내 앵커는 null", () => {
    expect(resolveInternalLink("https://example.com/a.md", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("http://example.com", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("mailto:a@b.c", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("file:///etc/passwd", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("//cdn.example.com/a.md", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("#섹션", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("", CURRENT, ROOT)).toBeNull();
  });

  it("vault 밖으로 나가는 경로는 null", () => {
    expect(resolveInternalLink("../../etc/passwd", CURRENT, ROOT)).toBeNull();
    expect(resolveInternalLink("../../../a.md", CURRENT, ROOT)).toBeNull();
  });
});
