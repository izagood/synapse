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

function contentScale(): number {
  const content = host.querySelector(".zoom-content") as HTMLElement;
  const m = /scale\(([-0-9.]+)\)/.exec(content?.style.transform ?? "");
  return m ? Number(m[1]) : NaN;
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

  it("ctrl+휠(트랙패드 핀치)로 확대한다", () => {
    render("/notes/a.png");
    const surface = host.querySelector(".image-viewer") as HTMLElement;
    expect(contentScale()).toBeCloseTo(1, 5);
    act(() => {
      surface.dispatchEvent(
        new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(contentScale()).toBeGreaterThan(1);
  });

  it("더블클릭으로 맞춤↔확대를 토글한다", () => {
    render("/notes/a.png");
    const surface = host.querySelector(".image-viewer") as HTMLElement;
    act(() => surface.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(contentScale()).toBeGreaterThan(1);
    expect(surface.classList.contains("is-zoomed")).toBe(true);
    act(() =>
      (host.querySelector(".image-viewer") as HTMLElement).dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      ),
    );
    expect(contentScale()).toBeCloseTo(1, 5);
  });

  it("로드 실패 시 에러 메시지를 보여준다", () => {
    render("/notes/broken.png");
    const img = host.querySelector("img.image-viewer-img") as HTMLImageElement;
    act(() => img.dispatchEvent(new Event("error")));
    expect(host.querySelector(".image-viewer")).toBeNull();
    expect(host.querySelector("p.error")).not.toBeNull();
  });
});
