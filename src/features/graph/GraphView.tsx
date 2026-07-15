import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../ipc/ipc";
import type { LinkGraph } from "../../ipc/types";
import { useWorkspace } from "../../stores/workspace";
import { useT } from "../../i18n";
import {
  CloseIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from "../../shared/Icons";
import {
  LABEL_GAP,
  adjacencyOf,
  estimateLabelWidth,
  layoutGraph,
  placeLabels,
  type LabelCandidate,
} from "./layout";
import {
  applyZoom,
  gestureZoomFactor,
  wheelZoomFactor,
  type ZoomView as View,
} from "./zoom";

// WebKit(맥 Safari/WKWebView) 전용 핀치 이벤트 — lib.dom에 타입이 없다.
interface WebKitGestureEvent extends Event {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

const WIDTH = 900;
const HEIGHT = 600;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;

const displayName = (name: string) => name.replace(/\.(md|markdown)$/i, "");

// 연결 수(degree)에 비례한 노드 반지름 — 렌더와 라벨 배치가 함께 쓴다.
const radiusOf = (degree: number, maxDegree: number) =>
  degree > 0 ? 5 + (degree / maxDegree) * 9 : 3.2;

// 노트 링크 그래프 시각화 모달 (FR-6.2).
// 백링크 인덱스를 그래프(노드=노트, 엣지=링크)로 재사용한다.
// 노드 클릭 → 노트 열기. 현재 노트 강조, 호버·검색 시 인접/일치 노드 강조.
// 연결 수(degree)로 노드 크기·색을 나눠 위계를 만들고, 줌/팬으로 탐색한다.
export function GraphView({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const activePath = useWorkspace((s) => s.activePath);
  const openFileAt = useWorkspace((s) => s.openFileAt);
  const t = useT();

  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });

  const svgRef = useRef<SVGSVGElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // 드래그 팬 상태 — 클릭과 구분하려고 이동 여부(panned)를 기억한다.
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(
    null,
  );
  const panned = useRef(false);

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
    () => (graph ? layoutGraph(graph, { width: WIDTH, height: HEIGHT }) : null),
    [graph],
  );

  const maxDegree = useMemo(
    () =>
      layout && layout.nodes.length
        ? Math.max(1, ...layout.nodes.map((n) => n.degree))
        : 1,
    [layout],
  );

  // 호버한 노드의 인접 집합(엣지·노드 강조용)
  const neighbors = useMemo(
    () => (graph && hover ? adjacencyOf(graph, hover) : null),
    [graph, hover],
  );

  // 검색어와 이름이 일치하는 노드 경로 집합
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !layout) return null;
    const set = new Set<string>();
    for (const n of layout.nodes) {
      if (n.name.toLowerCase().includes(q)) set.add(n.path);
    }
    return set;
  }, [query, layout]);

  const posByPath = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    layout?.nodes.forEach((n) => m.set(n.path, { x: n.x, y: n.y }));
    return m;
  }, [layout]);

  const isEmpty = !loading && (!layout || layout.nodes.length === 0);
  const focusing = hover != null || matches != null;

  // 한 노드가 현재 강조 대상인지: 검색 중이면 일치, 호버 중이면 본인·이웃
  const isActive = (path: string) => {
    if (matches) return matches.has(path);
    if (hover) return path === hover || (neighbors?.has(path) ?? false);
    return false;
  };

  // 겹치지 않게 표시할 라벨 집합을 미리 계산한다.
  // - 포커스 중(호버·검색): 포커스 집합만 후보 → 연결된 노트 제목이
  //   배경 허브에 가리지 않고 우선 배치된다. 호버한 노드는 항상 표시.
  // - 평상시: 전 노드가 후보 — 겹침 회피가 밀도 필터 역할을 해서
  //   축소 화면에선 허브 위주로, 확대할수록 주변 이름이 드러난다.
  // 라벨은 화면 고정 크기(11px)로 그리므로 충돌 판정도 화면(px) 공간
  // 에서 한다: 좌표·반지름에 줌 배율 k를 곱하고 글자 폭은 그대로 둔다.
  // 확대하면 노드 간 화면 거리가 벌어져 통과하는 라벨이 자연히 늘어난다.
  const shownLabels = useMemo(() => {
    if (!layout) return new Set<string>();
    const k = view.k;
    const cands: LabelCandidate[] = [];
    for (const n of layout.nodes) {
      const isCurrent = n.path === activePath;
      const active = matches
        ? matches.has(n.path)
        : hover
          ? n.path === hover || (neighbors?.has(n.path) ?? false)
          : false;
      const inFocus = active || isCurrent || n.path === hover;
      if (focusing && !inFocus) continue;
      const force = focusing ? n.path === hover : isCurrent;
      cands.push({
        path: n.path,
        x: n.x * k,
        y: n.y * k,
        r: radiusOf(n.degree, maxDegree) * k,
        width: estimateLabelWidth(displayName(n.name)),
        // 현재 노트·이웃을 배경 허브보다 위로 — 큰 degree일수록 먼저 배치.
        priority: n.degree + (isCurrent ? 1000 : 0) + (active ? 100 : 0),
        force,
      });
    }
    return placeLabels(cands);
  }, [layout, focusing, hover, matches, neighbors, activePath, maxDegree, view.k]);

  const zoomAt = (vx: number, vy: number, factor: number) => {
    setView((v) => applyZoom(v, vx, vy, factor, MIN_ZOOM, MAX_ZOOM));
  };

  // 휠 줌은 네이티브 non-passive 리스너로 — 합성 onWheel은 preventDefault가 막힐 수 있다.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
      const y = ((e.clientY - rect.top) / rect.height) * HEIGHT;
      zoomAt(x, y, wheelZoomFactor(e));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [loading, isEmpty]);

  // 맥 WKWebView의 트랙패드 핀치는 wheel이 아니라 WebKit 고유 GestureEvent로
  // 온다(실측: 핀치 시 wheel+ctrlKey 0건). svg에서 직접 받아 그래프를 줌하고,
  // 백드롭에서 전파를 끊는다 — excalidraw가 document 레벨에서 핀치를 청취하므로
  // 끊지 않으면 모달 뒤에 열려 있는 드로잉 노트가 대신 줌된다.
  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const svg = svgRef.current;

    let prevScale = 0;
    const onGesture = (e: Event) => {
      const g = e as WebKitGestureEvent;
      e.preventDefault();
      if (e.type === "gesturestart") {
        prevScale = g.scale > 0 ? g.scale : 1;
        return;
      }
      if (e.type === "gestureend") {
        prevScale = 0;
        return;
      }
      if (!svg || !prevScale || !svg.contains(e.target as Node)) return;
      const rect = svg.getBoundingClientRect();
      const x = ((g.clientX - rect.left) / rect.width) * WIDTH;
      const y = ((g.clientY - rect.top) / rect.height) * HEIGHT;
      zoomAt(x, y, gestureZoomFactor(g.scale, prevScale));
      prevScale = g.scale;
    };
    // 백드롭(모달 전체) 단일 지점: svg 위 핀치는 줌으로 처리하고, 헤더·여백
    // 위 핀치도 여기서 소비돼 뒤 노트로 새지 않는다.
    const stop = (e: Event) => e.stopPropagation();
    for (const type of GESTURE_EVENTS) {
      backdrop.addEventListener(type, onGesture);
      backdrop.addEventListener(type, stop);
    }
    return () => {
      for (const type of GESTURE_EVENTS) {
        backdrop.removeEventListener(type, onGesture);
        backdrop.removeEventListener(type, stop);
      }
    };
  }, [loading, isEmpty]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    panned.current = false;
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!panned.current && Math.abs(dx) + Math.abs(dy) > 4) {
      // 팬이 실제로 시작된 뒤에만 포인터를 캡처한다. pointerdown에서 바로
      // 캡처하면 click이 svg로 재타게팅돼 노드의 onClick이 실행되지 않는다.
      panned.current = true;
      svgRef.current?.setPointerCapture(e.pointerId);
    }
    if (!panned.current) return;
    setView((v) => ({
      ...v,
      tx: d.tx + (dx / rect.width) * WIDTH,
      ty: d.ty + (dy / rect.height) * HEIGHT,
    }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="modal graph-modal" onClick={(e) => e.stopPropagation()}>
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
          {!loading && !isEmpty && (
            <label className="graph-search">
              <SearchIcon size={14} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("graph.searchPlaceholder")}
                spellCheck={false}
              />
            </label>
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
          <div className="graph-stage">
            <svg
              ref={svgRef}
              className="graph-canvas"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              width="100%"
              role="img"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <defs>
                {/* 헤일로용 소프트 글로우 — 원판 대신 중심→가장자리 페이드 */}
                <radialGradient id="graph-halo-grad">
                  <stop offset="0%" className="graph-halo-stop-core" />
                  <stop offset="100%" className="graph-halo-stop-edge" />
                </radialGradient>
              </defs>
              {/* SVG는 문서 순서가 곧 쌓임 순서다. 헤일로가 이웃 노드의
                  라벨을 덮지 않도록 엣지 → 헤일로 → 점 → 라벨 레이어로
                  나눠 그린다(라벨이 항상 최상단). */}
              <g
                transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}
              >
                {layout!.edges.map((e, i) => {
                  const a = posByPath.get(e.source);
                  const b = posByPath.get(e.target);
                  if (!a || !b) return null;
                  const active = isActive(e.source) || isActive(e.target);
                  const dimmed = focusing && !active;
                  return (
                    <line
                      key={`${e.source}->${e.target}:${i}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      vectorEffect="non-scaling-stroke"
                      className={[
                        "graph-edge",
                        active ? "graph-edge-active" : "",
                        dimmed ? "graph-edge-dimmed" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                  );
                })}
                {layout!.nodes.map((n) => {
                  const isCurrent = n.path === activePath;
                  const linked = n.degree > 0;
                  if (!linked && !isCurrent) return null;
                  const active = isActive(n.path);
                  const dimmed = focusing && !active && !isCurrent;
                  return (
                    <circle
                      key={n.path}
                      cx={n.x}
                      cy={n.y}
                      r={radiusOf(n.degree, maxDegree) * 1.6}
                      fill="url(#graph-halo-grad)"
                      className={[
                        "graph-halo",
                        isCurrent ? "graph-halo-current" : "",
                        active ? "graph-halo-active" : "",
                        dimmed ? "graph-halo-dimmed" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                  );
                })}
                {layout!.nodes.map((n) => {
                  const isCurrent = n.path === activePath;
                  const active = isActive(n.path);
                  const dimmed = focusing && !active && !isCurrent;
                  const linked = n.degree > 0;
                  const r = radiusOf(n.degree, maxDegree);
                  const cls = [
                    "graph-node",
                    linked ? "graph-node-linked" : "graph-node-iso",
                    isCurrent ? "graph-node-current" : "",
                    active ? "graph-node-active" : "",
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
                      onMouseLeave={() =>
                        setHover((h) => (h === n.path ? null : h))
                      }
                      onClick={() => {
                        if (panned.current) return;
                        void openFileAt(n.path);
                        onClose();
                      }}
                    >
                      <title>{n.name}</title>
                      <circle
                        r={r}
                        vectorEffect="non-scaling-stroke"
                        className="graph-node-dot"
                      />
                    </g>
                  );
                })}
                {layout!.nodes.map((n) => {
                  if (!shownLabels.has(n.path)) return null;
                  const isCurrent = n.path === activePath;
                  const active = isActive(n.path);
                  const dimmed = focusing && !active && !isCurrent;
                  const r = radiusOf(n.degree, maxDegree);
                  const k = view.k;
                  // 화면 고정 크기 라벨: 줌 그룹 안에서 1/k로 역보정해
                  // 화면에선 항상 11px — 확대할수록 더 많은 이름이 보인다.
                  return (
                    <text
                      key={n.path}
                      x={n.x + r + LABEL_GAP / k}
                      y={n.y + 4 / k}
                      style={{
                        fontSize: `${11 / k}px`,
                        strokeWidth: `${3.5 / k}px`,
                      }}
                      className={[
                        "graph-node-label",
                        isCurrent ? "graph-node-label-current" : "",
                        active ? "graph-node-label-active" : "",
                        dimmed ? "graph-node-label-dimmed" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {displayName(n.name)}
                    </text>
                  );
                })}
              </g>
            </svg>

            <div className="graph-zoom">
              <button
                onClick={() => zoomAt(WIDTH / 2, HEIGHT / 2, 1.25)}
                title={t("graph.zoomIn")}
                aria-label={t("graph.zoomIn")}
              >
                <PlusIcon size={15} />
              </button>
              <button
                onClick={() => zoomAt(WIDTH / 2, HEIGHT / 2, 1 / 1.25)}
                title={t("graph.zoomOut")}
                aria-label={t("graph.zoomOut")}
              >
                <MinusIcon size={15} />
              </button>
              <button
                onClick={() => setView({ k: 1, tx: 0, ty: 0 })}
                title={t("graph.resetView")}
                aria-label={t("graph.resetView")}
              >
                <RefreshIcon size={15} />
              </button>
            </div>

            <p className="graph-hint">{t("graph.hint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
