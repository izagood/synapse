import { describe, expect, it } from "vitest";
import { computeBacklinks, extractLinks, linksInLine } from "./backlinks";

const ROOT = "/vault";

describe("linksInLine", () => {
  it("표준 링크를 추출한다", () => {
    expect(linksInLine("see [목차](../00-목차.md) and [home](/README.md)")).toEqual([
      { kind: "standard", href: "../00-목차.md" },
      { kind: "standard", href: "/README.md" },
    ]);
  });

  it("위키링크와 별칭을 추출한다", () => {
    expect(linksInLine("link [[노트A]] and [[노트B|별칭]]")).toEqual([
      { kind: "wiki", name: "노트A" },
      { kind: "wiki", name: "노트B" },
    ]);
  });

  it("이미지와 인라인 코드는 무시한다", () => {
    expect(linksInLine("![alt](img.png) `[[code]]` [real](note.md)")).toEqual([
      { kind: "standard", href: "note.md" },
    ]);
  });
});

describe("extractLinks", () => {
  it("코드펜스 안의 링크는 무시한다", () => {
    const body = "[a](a.md)\n```\n[[fenced]]\n[b](b.md)\n```\n[[c]]";
    expect(extractLinks(body).map((x) => x.link)).toEqual([
      { kind: "standard", href: "a.md" },
      { kind: "wiki", name: "c" },
    ]);
  });
});

describe("computeBacklinks", () => {
  it("표준 링크와 위키링크 백링크를 모은다", () => {
    const files = new Map<string, string>([
      [`${ROOT}/target.md`, "# 대상"],
      [`${ROOT}/a.md`, "표준 [대상](target.md) 링크"],
      [`${ROOT}/sub/b.md`, "상대 [t](../target.md) 와 위키 [[target]]"],
      [`${ROOT}/c.md`, "관련 없음"],
    ]);
    const backs = computeBacklinks(ROOT, `${ROOT}/target.md`, files);
    const names = backs.map((b) => b.sourceName);
    expect(names).toContain("a.md");
    expect(names).toContain("b.md");
    expect(names).not.toContain("c.md");
  });

  it("위키링크를 basename으로 폴더 넘어 해석한다", () => {
    const files = new Map<string, string>([
      [`${ROOT}/notes/대상.md`, "# 대상"],
      [`${ROOT}/other/source.md`, "위키 [[대상]] 링크"],
    ]);
    const backs = computeBacklinks(ROOT, `${ROOT}/notes/대상.md`, files);
    expect(backs).toHaveLength(1);
    expect(backs[0].sourceName).toBe("source.md");
  });

  it("자기 자신은 제외한다", () => {
    const files = new Map<string, string>([
      [`${ROOT}/target.md`, "자기 참조 [self](target.md)"],
      [`${ROOT}/real.md`, "[t](target.md)"],
    ]);
    const backs = computeBacklinks(ROOT, `${ROOT}/target.md`, files);
    expect(backs.map((b) => b.sourceName)).toEqual(["real.md"]);
  });

  it("존재하지 않는 대상은 빈 결과", () => {
    const files = new Map<string, string>([[`${ROOT}/a.md`, "[x](존재.md)"]]);
    expect(computeBacklinks(ROOT, `${ROOT}/없음.md`, files)).toEqual([]);
  });
});
