import { describe, expect, it } from "vitest";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";

describe("frontmatter split/join", () => {
  it("passes through documents without frontmatter", () => {
    const doc = "# 제목\n\n본문";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBeNull();
    expect(body).toBe(doc);
    expect(joinFrontmatter(frontmatter, body)).toBe(doc);
  });

  it("splits and rejoins frontmatter losslessly (semantics)", () => {
    const doc = "---\ntitle: 메모\ntags: [a, b]\n---\n\n# 본문 제목\n";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe("---\ntitle: 메모\ntags: [a, b]\n---");
    expect(body).toBe("# 본문 제목\n");
    expect(joinFrontmatter(frontmatter, body)).toBe(doc);
  });

  it("handles frontmatter without trailing blank line", () => {
    const doc = "---\na: 1\n---\n# 바로 본문";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe("---\na: 1\n---");
    expect(body).toBe("# 바로 본문");
  });

  it("does not treat a thematic break mid-document as frontmatter", () => {
    const doc = "본문 먼저\n\n---\n\n더 많은 본문";
    expect(splitFrontmatter(doc).frontmatter).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const doc = "---\r\ntitle: x\r\n---\r\n\r\n본문";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toContain("title: x");
    expect(body).toBe("본문");
  });

  it("handles frontmatter-only documents", () => {
    const doc = "---\ntitle: x\n---";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe("---\ntitle: x\n---");
    expect(body).toBe("");
  });

  it("빈 frontmatter(붙은 ---/---)를 인식한다 (L1, 옵시디언 호환)", () => {
    const doc = "---\n---\n본문";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBe("---\n---");
    expect(body).toBe("본문");
  });

  it("수평선 2개(사이 빈 줄)로 시작하는 문서를 frontmatter로 오인하지 않는다 (M12)", () => {
    // 에디터가 수평선 2개를 `---\n\n---` 로 정규화해 저장한 문서 —
    // frontmatter로 오인하면 다음 열기에서 내용 증발처럼 보인다(2단 스왈로우).
    const doc = "---\n\n---\n\n본문";
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(frontmatter).toBeNull();
    expect(body).toBe(doc);
    // 왕복해도 frontmatter가 생기지 않는다
    expect(splitFrontmatter(joinFrontmatter(frontmatter, body)).frontmatter).toBeNull();
  });

  it("여는 --- 다음이 공백뿐인 줄이어도 frontmatter가 아니다", () => {
    expect(splitFrontmatter("---\n  \n---\n본문").frontmatter).toBeNull();
  });
});
