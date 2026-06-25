import { useEffect, useRef, useState } from "react";
import { ipc } from "../../ipc/ipc";
import { useT } from "../../i18n";
import { useWorkspace } from "../../stores/workspace";
import { basename, dirname } from "../../shared/pathUtils";
import { isEmptyDoc, bakedPdfNameOf } from "./drawDoc";
import { buildBakedPdf, bytesToBase64, fetchPdfBytes } from "./bakePdf";
import type { PdfDrawApi } from "./usePdfDraw";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function PdfDrawMenu({
  x,
  y,
  page,
  path,
  draw,
  onClose,
}: {
  x: number;
  y: number;
  page: number | null;
  path: string;
  draw: PdfDrawApi;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const root = useWorkspace((s) => s.root);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const openFile = useWorkspace((s) => s.openFile);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 바깥 클릭/Esc 로 닫기 (TreeContextMenu 와 동일한 캡처 단계 처리).
  useEffect(() => {
    const onOutside = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const bake = async () => {
    if (!root) return;
    if (!isTauri) {
      setMsg(t("pdfDraw.bakeUnsupported"));
      return;
    }
    if (isEmptyDoc(draw.getDoc())) {
      setMsg(t("pdfDraw.bakeEmpty"));
      return;
    }
    setBusy(true);
    setMsg(t("pdfDraw.baking"));
    try {
      const original = await fetchPdfBytes(path);
      const baked = await buildBakedPdf(original, draw.getDoc());
      const dir = dirname(path);
      const desired = bakedPdfNameOf(basename(path));
      const finalName = await ipc.writeBinaryUnique(
        root,
        dir,
        desired,
        bytesToBase64(baked),
      );
      await refreshTree();
      const newPath = `${dir}/${finalName}`;
      await openFile({ path: newPath, name: finalName, kind: "file", fileType: "pdf" });
      onClose();
    } catch {
      setBusy(false);
      setMsg(t("pdfDraw.bakeFailed"));
    }
  };

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      <button type="button" disabled={busy} onClick={() => void bake()}>
        {busy ? t("pdfDraw.baking") : t("pdfDraw.bake")}
      </button>
      {page !== null && (
        <button type="button" disabled={busy} onClick={() => run(() => draw.clearPage(page))}>
          {t("pdfDraw.clearPage")}
        </button>
      )}
      <button
        type="button"
        disabled={busy || draw.shapeCount === 0}
        onClick={() => run(() => draw.clearAll())}
      >
        {t("pdfDraw.clearAll")}
      </button>
      {msg && !busy && <div className="context-menu-note">{msg}</div>}
    </div>
  );
}
