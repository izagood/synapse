import { describe, expect, it } from "vitest";
import type { EditPreview } from "../../ipc/types";
import {
  applyEditToBase,
  fileLabel,
  planApproval,
  planRejection,
  previewDiff,
} from "./permission";

const edit = (over: Partial<EditPreview>): EditPreview => ({
  filePath: "/notes/a.md",
  oldString: "",
  newString: "",
  wholeFile: false,
  ...over,
});

describe("planApproval", () => {
  it("편집 도구는 CLI 직접 쓰기를 막고 CRDT 경유로 적용한다", () => {
    const plan = planApproval({
      requestId: "r",
      tool: "Edit",
      detail: "",
      edit: edit({ oldString: "a", newString: "b" }),
    });
    expect(plan).toEqual({ allowCli: false, applyEdit: true });
  });

  it("비편집 도구는 CLI에 그대로 허용한다", () => {
    const plan = planApproval({ requestId: "r", tool: "Read", detail: "", edit: null });
    expect(plan).toEqual({ allowCli: true, applyEdit: false });
  });

  it("거부는 항상 deny이고 아무것도 적용하지 않는다", () => {
    expect(planRejection()).toEqual({ allowCli: false, applyEdit: false });
  });
});

describe("applyEditToBase", () => {
  it("Write는 전체를 교체한다", () => {
    expect(applyEditToBase("옛 내용", edit({ wholeFile: true, newString: "새 전문" }))).toBe(
      "새 전문",
    );
  });

  it("Edit은 유일한 일치를 치환한다", () => {
    expect(applyEditToBase("x foo y", edit({ oldString: "foo", newString: "bar" }))).toBe(
      "x bar y",
    );
  });

  it("일치가 없거나 여러 번이면 에러", () => {
    expect(() => applyEditToBase("hello", edit({ oldString: "zzz", newString: "q" }))).toThrow();
    expect(() => applyEditToBase("a a", edit({ oldString: "a", newString: "b" }))).toThrow();
    expect(() => applyEditToBase("x", edit({ oldString: "", newString: "y" }))).toThrow();
  });
});

describe("previewDiff", () => {
  it("Edit은 삭제 줄 다음 추가 줄을 보여준다", () => {
    const lines = previewDiff(edit({ oldString: "old1\nold2", newString: "new1" }));
    expect(lines).toEqual([
      { kind: "del", text: "old1" },
      { kind: "del", text: "old2" },
      { kind: "add", text: "new1" },
    ]);
  });

  it("Write는 전체를 추가로 보여준다", () => {
    const lines = previewDiff(edit({ wholeFile: true, newString: "a\nb" }));
    expect(lines).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });
});

describe("fileLabel", () => {
  it("경로에서 파일명만 뽑는다", () => {
    expect(fileLabel(edit({ filePath: "/a/b/c.md" }))).toBe("c.md");
    expect(fileLabel(edit({ filePath: "c.md" }))).toBe("c.md");
  });
});
