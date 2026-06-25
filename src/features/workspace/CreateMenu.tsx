import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { clampMenuPosition } from "./fileTreeUtils";

export interface CreateMenuProps {
  /** 메뉴를 띄울 기준 좌표 (보통 + 버튼 아래) */
  anchor: { x: number; y: number };
  onNote: () => void;
  onFolder: () => void;
  onDrawing: () => void;
  onDiagram: () => void;
  onClose: () => void;
}

// + 버튼에서 여는 "새로 만들기" 드롭다운. 파일 트리 우클릭 메뉴와 같은 스타일을
// 쓰되, 마우스 우클릭이 막히는 환경(일부 Windows)에서도 생성 기능을 쓸 수 있게 한다.
export function CreateMenu({
  anchor,
  onNote,
  onFolder,
  onDrawing,
  onDiagram,
  onClose,
}: CreateMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  // 바깥 클릭/우클릭 또는 Esc로 닫는다 (캡처 단계로 들어 자식의 전파 차단에도 동작).
  useEffect(() => {
    const onOutside = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("contextmenu", onOutside, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("contextmenu", onOutside, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 메뉴가 창 밖으로 넘치면 안쪽으로 밀어 넣는다
  const [pos, setPos] = useState(anchor);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        anchor.x,
        anchor.y,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [anchor]);

  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }}>
      <button onClick={() => run(onNote)}>{t("fileTree.newNote")}</button>
      <button onClick={() => run(onFolder)}>{t("fileTree.newFolder")}</button>
      <button onClick={() => run(onDrawing)}>{t("fileTree.newDrawing")}</button>
      <button onClick={() => run(onDiagram)}>{t("fileTree.newDiagram")}</button>
    </div>
  );
}
