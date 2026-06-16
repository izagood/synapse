// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ImageViewer } from "./ImageViewer";

let root: Root | null = null;
let host: HTMLDivElement;

function render(path: string) {
  root = createRoot(host);
  act(() => {
    root!.render(<ImageViewer path={path} />);
  });
}

describe("ImageViewer", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it("경로를 asset URL로 변환해 img src로 렌더링한다", () => {
    // 테스트 환경(isTauri=false)에서는 resolveAssetUrl이 경로를 그대로 반환한다
    render("/notes/assets/diagram.png");
    const img = host.querySelector("img.image-viewer-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/notes/assets/diagram.png");
  });

  it("클릭하면 실제 크기 모드를 토글한다", () => {
    render("/notes/a.png");
    const container = host.querySelector(".image-viewer") as HTMLElement;
    const img = host.querySelector("img.image-viewer-img") as HTMLImageElement;
    expect(container.classList.contains("is-actual")).toBe(false);
    act(() => img.click());
    expect(host.querySelector(".image-viewer")!.classList.contains("is-actual")).toBe(true);
    act(() => (host.querySelector("img.image-viewer-img") as HTMLImageElement).click());
    expect(host.querySelector(".image-viewer")!.classList.contains("is-actual")).toBe(false);
  });

  it("로드 실패 시 에러 메시지를 보여준다", () => {
    render("/notes/broken.png");
    const img = host.querySelector("img.image-viewer-img") as HTMLImageElement;
    act(() => img.dispatchEvent(new Event("error")));
    expect(host.querySelector(".image-viewer")).toBeNull();
    expect(host.querySelector("p.error")).not.toBeNull();
  });
});
