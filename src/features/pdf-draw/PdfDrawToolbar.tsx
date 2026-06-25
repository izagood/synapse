import { useT } from "../../i18n";
import type { PdfDrawApi } from "./usePdfDraw";
import type { ToolKind } from "./drawDoc";

// 펜/형광펜에 공통으로 쓰는 기본 색 팔레트.
const COLORS = ["#e02424", "#1f2937", "#2563eb", "#16a34a", "#f59e0b", "#db2777"];
const WIDTHS: { key: "thin" | "medium" | "thick"; value: number }[] = [
  { key: "thin", value: 2 },
  { key: "medium", value: 3 },
  { key: "thick", value: 6 },
];
const MIN_WIDTH = 1;
const MAX_WIDTH = 30;

const TOOL_ICON: Record<ToolKind, string> = {
  move: "✋",
  pen: "✎",
  highlighter: "🖍",
  eraser: "▱",
};

export function PdfDrawToolbar({ draw }: { draw: PdfDrawApi }) {
  const t = useT();
  const tools: ToolKind[] = ["move", "pen", "highlighter", "eraser"];
  // 색/굵기/불투명도는 그리는 도구일 때만 의미가 있다.
  const showStyle = draw.tool === "pen" || draw.tool === "highlighter";

  return (
    <div className="pdf-draw-toolbar" role="toolbar" aria-label={t("pdfDraw.pen")}>
      <div className="pdf-draw-group">
        {tools.map((tk) => (
          <button
            key={tk}
            type="button"
            className={`pdf-draw-tool${draw.tool === tk ? " active" : ""}`}
            aria-pressed={draw.tool === tk}
            title={t(`pdfDraw.${tk}`)}
            aria-label={t(`pdfDraw.${tk}`)}
            onClick={() => draw.setTool(tk)}
          >
            {TOOL_ICON[tk]}
          </button>
        ))}
      </div>

      {showStyle && (
        <>
          <div className="pdf-draw-group" aria-label={t("pdfDraw.color")}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`pdf-draw-swatch${draw.color === c ? " active" : ""}`}
                style={{ background: c }}
                aria-pressed={draw.color === c}
                aria-label={c}
                title={c}
                onClick={() => draw.setColor(c)}
              />
            ))}
            <label
              className="pdf-draw-swatch pdf-draw-swatch-custom"
              title={t("pdfDraw.customColor")}
            >
              <input
                type="color"
                value={draw.color}
                aria-label={t("pdfDraw.customColor")}
                onChange={(e) => draw.setColor(e.target.value)}
              />
            </label>
          </div>

          {draw.recentColors.length > 0 && (
            <div className="pdf-draw-group" aria-label={t("pdfDraw.recentColors")}>
              {draw.recentColors.map((c) => (
                <button
                  key={`recent-${c}`}
                  type="button"
                  className={`pdf-draw-swatch${draw.color === c ? " active" : ""}`}
                  style={{ background: c }}
                  aria-label={c}
                  title={c}
                  onClick={() => draw.setColor(c)}
                />
              ))}
            </div>
          )}

          <div className="pdf-draw-group" aria-label={t("pdfDraw.width")}>
            {WIDTHS.map((w) => (
              <button
                key={w.key}
                type="button"
                className={`pdf-draw-width${draw.width === w.value ? " active" : ""}`}
                aria-pressed={draw.width === w.value}
                title={t(`pdfDraw.${w.key}`)}
                aria-label={t(`pdfDraw.${w.key}`)}
                onClick={() => draw.setWidth(w.value)}
              >
                <span
                  className="pdf-draw-width-dot"
                  style={{ width: w.value * 2, height: w.value * 2 }}
                />
              </button>
            ))}
            <input
              type="range"
              className="pdf-draw-range"
              min={MIN_WIDTH}
              max={MAX_WIDTH}
              step={1}
              value={draw.width}
              title={t("pdfDraw.width")}
              aria-label={t("pdfDraw.width")}
              onChange={(e) => draw.setWidth(Number(e.target.value))}
            />
          </div>

          <div className="pdf-draw-group" aria-label={t("pdfDraw.opacity")}>
            <input
              type="range"
              className="pdf-draw-range"
              min={0.1}
              max={1}
              step={0.05}
              value={draw.opacity}
              title={t("pdfDraw.opacity")}
              aria-label={t("pdfDraw.opacity")}
              onChange={(e) => draw.setOpacity(Number(e.target.value))}
            />
          </div>
        </>
      )}

      <div className="pdf-draw-group">
        <button
          type="button"
          className="pdf-draw-tool"
          title={t("pdfDraw.undo")}
          aria-label={t("pdfDraw.undo")}
          disabled={draw.shapeCount === 0}
          onClick={() => draw.undo()}
        >
          ↺
        </button>
        <button
          type="button"
          className="pdf-draw-tool"
          title={t("pdfDraw.redo")}
          aria-label={t("pdfDraw.redo")}
          disabled={!draw.canRedo}
          onClick={() => draw.redo()}
        >
          ↻
        </button>
      </div>
    </div>
  );
}
