import { useEffect, useMemo, useState } from "react";
import { ipc } from "../../ipc/ipc";
import type { LinkGraph } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import { CloseIcon } from "../../shared/Icons";
import { adjacencyOf, layoutGraph } from "./layout";

const WIDTH = 760;
const HEIGHT = 520;

// 노트 링크 그래프 시각화 모달 (FR-6.2).
// 백링크 인덱스를 그래프(노드=노트, 엣지=링크)로 재사용한다.
// 노드 클릭 → 노트 열기. 현재 노트 강조, 호버 시 인접 노드 강조.
export function GraphView({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const activePath = useWorkspace((s) => s.activePath);
  const openFileAt = useWorkspace((s) => s.openFileAt);
  const t = useT();

  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (!root) {
      setGraph({ nodes: [], edges: [] });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    ipc
      .linkGraph(root)
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch(() => {
        if (!cancelled) setGraph({ nodes: [], edges: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layout = useMemo(
    () =>
      graph
        ? layoutGraph(graph, { width: WIDTH, height: HEIGHT })
        : null,
    [graph],
  );

  // 호버한 노드의 인접 집합(엣지·노드 강조용)
  const neighbors = useMemo(
    () => (graph && hover ? adjacencyOf(graph, hover) : null),
    [graph, hover],
  );

  const posByPath = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    layout?.nodes.forEach((n) => m.set(n.path, { x: n.x, y: n.y }));
    return m;
  }, [layout]);

  const isEmpty = !loading && (!layout || layout.nodes.length === 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal graph-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="graph-header">
          <h2>{t("graph.title")}</h2>
          {layout && !loading && (
            <span className="graph-stats">
              {t("graph.stats", {
                nodes: layout.nodes.length,
                edges: layout.edges.length,
              })}
            </span>
          )}
          <button
            className="graph-close"
            onClick={onClose}
            title={t("graph.close")}
            aria-label={t("graph.close")}
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {loading ? (
          <p className="graph-message">{t("graph.loading")}</p>
        ) : isEmpty ? (
          <p className="graph-message">{t("graph.empty")}</p>
        ) : (
          <svg
            className="graph-canvas"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            width="100%"
            role="img"
          >
            {layout!.edges.map((e, i) => {
              const a = posByPath.get(e.source);
              const b = posByPath.get(e.target);
              if (!a || !b) return null;
              const active =
                hover != null &&
                (e.source === hover || e.target === hover);
              return (
                <line
                  key={`${e.source}->${e.target}:${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={
                    active ? "graph-edge graph-edge-active" : "graph-edge"
                  }
                />
              );
            })}
            {layout!.nodes.map((n) => {
              const isCurrent = n.path === activePath;
              const isHovered = n.path === hover;
              const isNeighbor = neighbors?.has(n.path) ?? false;
              const dimmed =
                hover != null && !isHovered && !isNeighbor;
              const r = 5 + Math.min(6, n.degree);
              const cls = [
                "graph-node",
                isCurrent ? "graph-node-current" : "",
                isHovered ? "graph-node-hover" : "",
                isNeighbor ? "graph-node-neighbor" : "",
                dimmed ? "graph-node-dimmed" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <g
                  key={n.path}
                  className={cls}
                  transform={`translate(${n.x} ${n.y})`}
                  onMouseEnter={() => setHover(n.path)}
                  onMouseLeave={() => setHover((h) => (h === n.path ? null : h))}
                  onClick={() => {
                    void openFileAt(n.path);
                    onClose();
                  }}
                >
                  <title>{n.name}</title>
                  <circle r={r} className="graph-node-circle" />
                  {(isCurrent || isHovered || isNeighbor) && (
                    <text x={r + 3} y={4} className="graph-node-label">
                      {n.name.replace(/\.(md|markdown)$/i, "")}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
