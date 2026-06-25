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
  adjacencyOf,
  estimateLabelWidth,
  initSim,
  placeLabels,
  reheat,
  setFixed,
  tickSim,
  type LabelCandidate,
  type SimState,
} from "./layout";
import {
  type Camera,
  IDENTITY,
  screenToWorld,
  zoomAround,
} from "./camera";
import { nodeAtScreen, type HitNode } from "./hitTest";
import { draw, radiusOf, type GraphTheme } from "./renderer";

const WIDTH = 900;
const HEIGHT = 600;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;
// sim.alpha 가 이 값 이하로 내려가면 안정화로 보고 RAF 루프를 멈춘다.
const ALPHA_MIN = 0.025;
// 클릭과 드래그를 가르는 이동 임계(px).
const PAN_THRESHOLD = 4;

const displayName = (name: string) => name.replace(/\.(md|markdown)$/i, "");

// 현재 CSS 변수에서 GraphTheme 를 끌어온다. Task 12 에서 themeFromCss 로 정교화.
// 여기서는 --accent/--fg 등 기존 토큰을 읽어 적당한 기본 테마를 만든다.
function themeFromCssVars(el: HTMLElement | null): GraphTheme {
  const cs = el ? getComputedStyle(el) : null;
  const v = (name: string, fallback: string) =>
    (cs?.getPropertyValue(name).trim() || fallback);
  const accent = v("--accent", "#7c6cf0");
  return {
    bg: "transparent", // CSS 배경(비네트·도트)을 살리려고 캔버스는 투명하게 그린다.
    edge: v("--fg-faint", "#6b6b74"),
    edgeActive: accent,
    node: accent,
    nodeIso: v("--fg-faint", "#6b6b74"),
    current: accent,
    label: v("--fg", "#d8d8dc"),
    halo: accent,
  };
}

// 노트 링크 그래프 시각화 모달 (FR-6.2).
// 백링크 인덱스를 그래프(노드=노트, 엣지=링크)로 재사용한다.
// 캔버스 + 실시간 force 시뮬레이션으로 렌더링하며, 호버/선택/드래그로 탐색한다.
//   - 호버: 이웃 강조 + 미니패널(임시).
//   - 선택 안 된 노드 클릭: selected 설정(강조·미니패널 고정).
//   - selected 인 노드 재클릭: 노트 열기 + 닫기.
//   - 드래그: 노드면 그 노드 이동, 빈 곳이면 카메라 팬.
//   - 검색: 일치 노드로 카메라 팬+줌.
export function GraphView({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root);
  const activePath = useWorkspace((s) => s.activePath);
  const openFileAt = useWorkspace((s) => s.openFileAt);
  const t = useT();

  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cam, setCam] = useState<Camera>(IDENTITY);
  const [sim, setSim] = useState<SimState | null>(null);

  // 필터: 고립 노드 표시·최소 degree·로컬(현재 노트 N홉) 그래프.
  const [showIsolated, setShowIsolated] = useState(true);
  const [minDegree, setMinDegree] = useState(0);
  const [localOnly, setLocalOnly] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  // 포인터 상호작용 상태 — 드래그 대상(노드/팬)과 이동 여부(panned)를 기억.
  const drag = useRef<{
    sx: number;
    sy: number;
    cam: Camera;
    nodePath: string | null;
  } | null>(null);
  const panned = useRef(false);

  // ── 그래프 로드 ──────────────────────────────────────────────
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

  // ── ESC 닫기 ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── 필터를 적용한 부분 그래프 ─────────────────────────────────
  // 로컬 그래프(현재 노트 N홉) → 고립 토글 → degree 임계 순으로 거른다.
  const effectiveGraph = useMemo<LinkGraph | null>(() => {
    if (!graph) return null;
    let nodes = graph.nodes;
    let edges = graph.edges;

    // 로컬 그래프: 현재 노트에서 N홉 안의 이웃만 남긴다.
    if (localOnly && activePath) {
      const HOPS = 2;
      const adj = new Map<string, Set<string>>();
      for (const e of edges) {
        (adj.get(e.source) ?? adj.set(e.source, new Set()).get(e.source)!).add(
          e.target,
        );
        (adj.get(e.target) ?? adj.set(e.target, new Set()).get(e.target)!).add(
          e.source,
        );
      }
      const keep = new Set<string>([activePath]);
      let frontier = new Set<string>([activePath]);
      for (let h = 0; h < HOPS; h += 1) {
        const next = new Set<string>();
        for (const p of frontier) {
          for (const nb of adj.get(p) ?? []) {
            if (!keep.has(nb)) {
              keep.add(nb);
              next.add(nb);
            }
          }
        }
        frontier = next;
      }
      nodes = nodes.filter((n) => keep.has(n.path));
      edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    }

    // degree 맵 (필터된 엣지 기준)
    const present = new Set(nodes.map((n) => n.path));
    const validEdges = edges.filter(
      (e) => present.has(e.source) && present.has(e.target),
    );
    const degree = new Map<string, number>();
    for (const n of nodes) degree.set(n.path, 0);
    for (const e of validEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    // 고립 노드 토글 + 최소 degree 임계 (현재 노트는 항상 남긴다)
    nodes = nodes.filter((n) => {
      if (n.path === activePath) return true;
      const d = degree.get(n.path) ?? 0;
      if (!showIsolated && d === 0) return false;
      if (d < minDegree) return false;
      return true;
    });
    const keep2 = new Set(nodes.map((n) => n.path));
    const finalEdges = validEdges.filter(
      (e) => keep2.has(e.source) && keep2.has(e.target),
    );
    return { nodes, edges: finalEdges };
  }, [graph, localOnly, activePath, showIsolated, minDegree]);

  // ── 시뮬레이션 초기화: 부분 그래프가 바뀌면 새로 배치 ──────────
  useEffect(() => {
    if (!effectiveGraph) {
      setSim(null);
      return;
    }
    setSim(initSim(effectiveGraph, { width: WIDTH, height: HEIGHT }));
  }, [effectiveGraph]);

  const maxDegree = useMemo(
    () =>
      sim && sim.nodes.length
        ? Math.max(1, ...sim.nodes.map((n) => n.degree))
        : 1,
    [sim],
  );

  const isEmpty = !loading && (!sim || sim.nodes.length === 0);

  // hover/selected 인접의 합집합 — renderer 가 한 neighbors 집합을 양쪽에
  // 함께 쓰므로(Task 10 review), 둘 다 있으면 union 을 넘겨야 강조가 옳다.
  const neighbors = useMemo(() => {
    if (!graph) return null;
    const a = hover ? adjacencyOf(graph, hover) : null;
    const b = selected ? adjacencyOf(graph, selected) : null;
    if (a && b) {
      const u = new Set(a);
      for (const p of b) u.add(p);
      return u;
    }
    return a ?? b;
  }, [graph, hover, selected]);

  // 검색어와 이름이 일치하는 노드 경로 집합
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !sim) return null;
    const set = new Set<string>();
    for (const n of sim.nodes) {
      if (n.name.toLowerCase().includes(q)) set.add(n.path);
    }
    return set.size ? set : new Set<string>();
  }, [query, sim]);

  const focusing = hover != null || selected != null || matches != null;

  // 한 노드가 강조 대상인지: matches 우선, 그다음 hover/selected/이웃.
  const isActive = (path: string): boolean => {
    if (matches) return matches.has(path);
    if (hover && (path === hover || (neighbors?.has(path) ?? false)))
      return true;
    if (selected && (path === selected || (neighbors?.has(path) ?? false)))
      return true;
    return false;
  };

  // 겹치지 않게 표시할 라벨 집합 — 기존 정책을 그대로 유지.
  const shownLabels = useMemo(() => {
    if (!sim) return new Set<string>();
    const focusNode = selected ?? hover;
    const cands: LabelCandidate[] = [];
    for (const n of sim.nodes) {
      const isCurrent = n.path === activePath;
      const active = matches
        ? matches.has(n.path)
        : isActive(n.path);
      const inFocus = active || isCurrent || n.path === focusNode;
      const eligible = focusing ? inFocus : n.degree >= 2 || isCurrent;
      if (!eligible) continue;
      const force = focusing ? n.path === focusNode : isCurrent;
      cands.push({
        path: n.path,
        x: n.x,
        y: n.y,
        r: radiusOf(n.degree, maxDegree),
        width: estimateLabelWidth(displayName(n.name)),
        priority: n.degree + (isCurrent ? 1000 : 0) + (active ? 100 : 0),
        force,
      });
    }
    return placeLabels(cands);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, focusing, hover, selected, matches, neighbors, activePath, maxDegree]);

  // ── dpr 캔버스 크기 맞춤 ─────────────────────────────────────
  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || WIDTH;
    const cssH = canvas.clientHeight || HEIGHT;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    return { dpr, width: cssW, height: cssH };
  };

  // 현재 상태를 한 프레임 그린다(idle 일 때도 호출돼 카메라/강조 변화 반영).
  const drawFrame = (state: SimState) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dims = resizeCanvas();
    if (!dims) return;
    draw(ctx, {
      sim: state,
      cam,
      theme: themeFromCssVars(canvas),
      width: dims.width,
      height: dims.height,
      dpr: dims.dpr,
      hover,
      selected,
      current: activePath,
      neighbors,
      matches,
      shownLabels,
      maxDegree,
    });
  };

  // ── RAF 루프: alpha > ALPHA_MIN 인 동안만 tick + draw ─────────
  // sim/카메라/강조 상태가 바뀔 때마다 effect 가 재실행되며, sim 이 아직
  // "뜨거우면"(alpha 큰) 루프를 (재)가동한다. 안정화되면 한 번만 그리고 멈춘다.
  useEffect(() => {
    if (!sim) return;
    let frame: number;
    const loop = () => {
      let stop = false;
      setSim((s) => {
        if (!s) {
          stop = true;
          return s;
        }
        if (s.alpha <= ALPHA_MIN) {
          stop = true;
          return s; // 그대로 — idle
        }
        const next = tickSim(s);
        drawFrame(next);
        return next;
      });
      if (!stop) {
        frame = requestAnimationFrame(loop);
        rafRef.current = frame;
      } else {
        rafRef.current = null;
      }
    };

    if (sim.alpha > ALPHA_MIN) {
      frame = requestAnimationFrame(loop);
      rafRef.current = frame;
    } else {
      // idle: tick 없이 현재 상태로 한 번만 그린다(카메라/강조 변화 반영).
      drawFrame(sim);
    }
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, cam, hover, selected, matches, shownLabels, neighbors, activePath]);

  // ── 검색: 일치 노드로 카메라 팬+줌 ───────────────────────────
  useEffect(() => {
    if (!matches || matches.size === 0 || !sim) return;
    const pts = sim.nodes.filter((n) => matches.has(n.path));
    if (!pts.length) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const dims = resizeCanvas();
    const vw = dims?.width ?? WIDTH;
    const vh = dims?.height ?? HEIGHT;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const k = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.min((vw * 0.6) / spanX, (vh * 0.6) / spanY)),
    );
    setCam({ k, tx: vw / 2 - cx * k, ty: vh / 2 - cy * k });
    // sim 위치는 매 tick 바뀌므로 검색어 변화에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  // ── 휠 줌: non-passive 리스너 + zoomAround ────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setCam((c) => zoomAround(c, sx, sy, factor, MIN_ZOOM, MAX_ZOOM));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [loading, isEmpty]);

  // ── 줌 버튼: 캔버스 중앙 기준 ─────────────────────────────────
  const zoomCentered = (factor: number) => {
    const dims = resizeCanvas();
    const vw = dims?.width ?? WIDTH;
    const vh = dims?.height ?? HEIGHT;
    setCam((c) => zoomAround(c, vw / 2, vh / 2, factor, MIN_ZOOM, MAX_ZOOM));
  };

  // 화면 좌표 → 캔버스 로컬 좌표
  const localPoint = (e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  // hitTest 용 노드 목록 (현재 sim 위치 기준)
  const hitNodes = (): HitNode[] =>
    sim
      ? sim.nodes.map((n) => ({
          path: n.path,
          x: n.x,
          y: n.y,
          r: radiusOf(n.degree, maxDegree),
        }))
      : [];

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !sim) return;
    const pt = localPoint(e);
    if (!pt) return;
    panned.current = false;
    const nodePath = nodeAtScreen(hitNodes(), cam, pt.sx, pt.sy);
    drag.current = { sx: pt.sx, sy: pt.sy, cam, nodePath };
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const pt = localPoint(e);
    if (!pt) return;
    if (!d) {
      // 드래그 중이 아니면 호버 갱신
      if (sim) {
        const hit = nodeAtScreen(hitNodes(), cam, pt.sx, pt.sy);
        setHover(hit);
      }
      return;
    }
    const dx = pt.sx - d.sx;
    const dy = pt.sy - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > PAN_THRESHOLD) panned.current = true;

    if (d.nodePath) {
      // 노드 드래그: 포인터 위치(world)로 노드를 옮기고 sim 재가열.
      const w = screenToWorld(cam, pt.sx, pt.sy);
      setSim((s) => (s ? reheat(setFixed(s, d.nodePath!, w.x, w.y, true)) : s));
    } else {
      // 빈 곳: 카메라 팬
      setCam({ k: d.cam.k, tx: d.cam.tx + dx, ty: d.cam.ty + dy });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    canvasRef.current?.releasePointerCapture(e.pointerId);
    if (!d) return;

    // 드래그였던 노드는 현재 위치 그대로 고정 해제 후 살짝 재가열해 안정화.
    if (d.nodePath && panned.current) {
      const path = d.nodePath;
      setSim((s) => {
        if (!s) return s;
        const cur = s.nodes.find((n) => n.path === path);
        if (!cur) return s;
        return reheat(setFixed(s, path, cur.x, cur.y, false), 0.3);
      });
      return;
    }

    if (panned.current) return; // 빈 곳 팬 → 클릭 아님

    // 클릭(이동 없음)
    const path = d.nodePath;
    if (!path) {
      // 빈 곳 클릭 → 선택 해제
      setSelected(null);
      return;
    }
    if (selected === path) {
      // 이미 선택된 노드 재클릭 → 노트 열기 + 닫기
      void openFileAt(path);
      onClose();
    } else {
      setSelected(path);
    }
  };

  // 미니패널에 표시할 노드 (선택 우선, 없으면 호버)
  const panelPath = selected ?? hover;
  const panelNode = useMemo(
    () => sim?.nodes.find((n) => n.path === panelPath) ?? null,
    [sim, panelPath],
  );
  // 미니패널: 백링크 수(들어오는 엣지) + 이웃 목록
  const panelInfo = useMemo(() => {
    if (!graph || !panelPath) return null;
    const backlinks = graph.edges.filter((e) => e.target === panelPath).length;
    const adj = adjacencyOf(graph, panelPath);
    const nameOf = new Map(graph.nodes.map((n) => [n.path, n.name]));
    const neighborList = [...adj]
      .map((p) => ({ path: p, name: nameOf.get(p) ?? p }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { backlinks, neighborList };
  }, [graph, panelPath]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal graph-modal" onClick={(e) => e.stopPropagation()}>
        <div className="graph-header">
          <h2>{t("graph.title")}</h2>
          {sim && !loading && (
            <span className="graph-stats">
              {t("graph.stats", {
                nodes: sim.nodes.length,
                edges: sim.edges.length,
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
            <canvas
              ref={canvasRef}
              className="graph-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                if (!drag.current) setHover(null);
              }}
            />

            {/* 필터 바 (좌상단) */}
            <div className="graph-filters">
              <label className="graph-filter-toggle">
                <input
                  type="checkbox"
                  checked={showIsolated}
                  onChange={(e) => setShowIsolated(e.target.checked)}
                />
                {t("graph.filters.isolated")}
              </label>
              <label className="graph-filter-slider">
                {t("graph.filters.minDegree")}
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={1}
                  value={minDegree}
                  onChange={(e) => setMinDegree(Number(e.target.value))}
                />
                <span className="graph-filter-value">{minDegree}</span>
              </label>
              <label className="graph-filter-toggle">
                <input
                  type="checkbox"
                  checked={localOnly}
                  disabled={!activePath}
                  onChange={(e) => setLocalOnly(e.target.checked)}
                />
                {t("graph.filters.local")}
              </label>
            </div>

            {/* 미니패널: 선택/호버 노드 정보 */}
            {panelNode && panelInfo && (
              <div className="graph-panel">
                <div className="graph-panel-title">
                  {displayName(panelNode.name)}
                </div>
                <div className="graph-panel-meta">
                  {t("graph.backlinks", { count: panelInfo.backlinks })}
                </div>
                {panelInfo.neighborList.length > 0 && (
                  <>
                    <div className="graph-panel-section">
                      {t("graph.neighbors")}
                    </div>
                    <ul className="graph-panel-neighbors">
                      {panelInfo.neighborList.map((nb) => (
                        <li key={nb.path}>
                          <button
                            type="button"
                            onClick={() => setSelected(nb.path)}
                          >
                            {displayName(nb.name)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button
                  type="button"
                  className="graph-panel-open"
                  onClick={() => {
                    void openFileAt(panelNode.path);
                    onClose();
                  }}
                >
                  {t("graph.openNote")}
                </button>
              </div>
            )}

            <div className="graph-zoom">
              <button
                onClick={() => zoomCentered(1.25)}
                title={t("graph.zoomIn")}
                aria-label={t("graph.zoomIn")}
              >
                <PlusIcon size={15} />
              </button>
              <button
                onClick={() => zoomCentered(1 / 1.25)}
                title={t("graph.zoomOut")}
                aria-label={t("graph.zoomOut")}
              >
                <MinusIcon size={15} />
              </button>
              <button
                onClick={() => setCam(IDENTITY)}
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
