import { describe, expect, it } from "vitest";
import { basename, fileTypeOf, stripExt, toRelativePath } from "./pathUtils";

describe("fileTypeOf", () => {
  it("마크다운 확장자를 분류한다", () => {
    expect(fileTypeOf("note.md")).toBe("markdown");
    expect(fileTypeOf("note.markdown")).toBe("markdown");
    expect(fileTypeOf("NOTE.MD")).toBe("markdown");
  });
  it("HTML 확장자를 분류한다", () => {
    expect(fileTypeOf("a.html")).toBe("html");
    expect(fileTypeOf("a.htm")).toBe("html");
  });
  it("PDF 확장자를 분류한다", () => {
    expect(fileTypeOf("report.pdf")).toBe("pdf");
    expect(fileTypeOf("REPORT.PDF")).toBe("pdf");
  });
  it("이미지 확장자를 분류한다", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]) {
      expect(fileTypeOf(`pic.${ext}`)).toBe("image");
    }
    expect(fileTypeOf("PIC.PNG")).toBe("image");
  });
  it("drawio 확장자를 분류한다", () => {
    expect(fileTypeOf("diagram.drawio")).toBe("drawio");
    expect(fileTypeOf("diagram.dio")).toBe("drawio");
    expect(fileTypeOf("Architecture.DRAWIO")).toBe("drawio");
  });
  it("Excalidraw 확장자를 분류한다", () => {
    expect(fileTypeOf("drawing.excalidraw")).toBe("excalidraw");
    expect(fileTypeOf("Sketch.EXCALIDRAW")).toBe("excalidraw");
    // Obsidian의 `.excalidraw.md`는 마지막 확장자(.md) 기준으로 마크다운
    expect(fileTypeOf("note.excalidraw.md")).toBe("markdown");
  });
  it("그 외는 other", () => {
    expect(fileTypeOf("data.json")).toBe("other");
    expect(fileTypeOf("noext")).toBe("other");
  });
});

describe("basename", () => {
  it("마지막 구성요소를 돌려준다", () => {
    expect(basename("/a/b/c.md")).toBe("c.md");
    expect(basename("c.md")).toBe("c.md");
  });
  it("백슬래시도 구분자로 본다", () => {
    expect(basename("a\\b\\c.md")).toBe("c.md");
  });
  it("빈 마지막 구성요소면 원본을 돌려준다", () => {
    expect(basename("/a/b/")).toBe("/a/b/");
  });
});

describe("stripExt", () => {
  it("마지막 확장자를 떼어낸다", () => {
    expect(stripExt("note.md")).toBe("note");
    expect(stripExt("a.tar.gz")).toBe("a.tar");
  });
  it("확장자가 없으면 그대로 둔다", () => {
    expect(stripExt("noext")).toBe("noext");
    expect(stripExt(".hidden")).toBe(".hidden");
  });
});

describe("toRelativePath", () => {
  it("루트 기준 상대 경로로 바꾼다", () => {
    expect(toRelativePath("/root", "/root/a/b.md")).toBe("a/b.md");
  });
  it("루트 자신은 .", () => {
    expect(toRelativePath("/root", "/root")).toBe(".");
  });
  it("루트 밖이면 절대 경로 그대로", () => {
    expect(toRelativePath("/root", "/other/x.md")).toBe("/other/x.md");
  });
  it("끝에 슬래시가 있는 루트도 처리한다", () => {
    expect(toRelativePath("/root/", "/root/a.md")).toBe("a.md");
  });
});
