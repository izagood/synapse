// GraphView 워크벤치 스토리.
// 빈 그래프 / 작은 그래프 / 허브 있는 그래프 × 라이트·다크·핑크 테마 조합.
//
// 주의: GraphView 는 ipc.linkGraph(root) + useWorkspace 를 의존한다.
// 스토리에서는 GraphCanvas 내부 캔버스 렌더러를 직접 사용해 의존 없이 테스트한다.
// themeFromCss·draw·buildScene 파이프라인이 올바르게 동작하는지 시각으로 확인한다.

import type { Story } from "@ladle/react";
import { useRef, useEffect } from "react";
import { ThemeFrame } from "../../ladle/ThemeFrame";
import { draw, themeFromCss } from "./renderer";
import { initSim, tickSim, type SimState } from "./layout";
import type { LinkGraph } from "../../ipc/types";

// ── 픽스처 그래프 데이터 ─────────────────────────────────────────────

const EMPTY_GRAPH: LinkGraph = { nodes: [], edges: [] };

const SMALL_GRAPH: LinkGraph = {
  nodes: [
    { path: "a.md", name: "a.md" },
    { path: "b.md", name: "b.md" },
    { path: "c.md", name: "c.md" },
  ],
  edges: [
    { source: "a.md", target: "b.md" },
    { source: "b.md", target: "c.md" },
  ],
};

const HUB_GRAPH: LinkGraph = {
  nodes: [
    { path: "hub.md", name: "hub.md" },
    { path: "n1.md", name: "n1.md" },
    { path: "n2.md", name: "n2.md" },
    { path: "n3.md", name: "n3.md" },
    { path: "n4.md", name: "n4.md" },
    { path: "n5.md", name: "n5.md" },
    { path: "iso.md", name: "iso.md" }, // 고립 노드
  ],
  edges: [
    { source: "hub.md", target: "n1.md" },
    { source: "hub.md", target: "n2.md" },
    { source: "hub.md", target: "n3.md" },
    { source: "hub.md", target: "n4.md" },
    { source: "hub.md", target: "n5.md" },
    { source: "n1.md", target: "n2.md" },
    { source: "n3.md", target: "n4.md" },
  ],
};

// ── 캔버스 렌더러 훅 ─────────────────────────────────────────────────

function useGraphCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  graph: LinkGraph,
  currentPath: string | null = null,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 400;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    if (graph.nodes.length === 0) {
      // 빈 그래프: 배경만
      const theme = themeFromCss(canvas);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.bg === "transparent" ? "var(--bg-panel, #252526)" : theme.bg;
      ctx.fillRect(0, 0, cssW, cssH);
      return;
    }

    // 시뮬레이션 안정화 (60 tick)
    let sim: SimState = initSim(graph, { width: cssW, height: cssH });
    for (let i = 0; i < 60; i++) sim = tickSim(sim);

    const maxDegree = Math.max(1, ...sim.nodes.map((n) => n.degree));

    draw(ctx, {
      sim,
      cam: { k: 1, tx: cssW / 2, ty: cssH / 2 },
      theme: themeFromCss(canvas),
      width: cssW,
      height: cssH,
      dpr,
      hover: null,
      selected: null,
      current: currentPath,
      neighbors: null,
      matches: null,
      shownLabels: new Set(sim.nodes.filter((n) => n.degree >= 1).map((n) => n.path)),
      maxDegree,
    });
  }, [canvasRef, graph, currentPath]);
}

// ── 스토리 컴포넌트 ──────────────────────────────────────────────────

function GraphCanvas({
  graph,
  currentPath,
}: {
  graph: LinkGraph;
  currentPath?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useGraphCanvas(canvasRef, graph, currentPath ?? null);

  return (
    <canvas
      ref={canvasRef}
      className="graph-canvas"
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}

function GraphStory({
  theme,
  graph,
  label,
  currentPath,
}: {
  theme: "light" | "dark" | "pink";
  graph: LinkGraph;
  label: string;
  currentPath?: string;
}) {
  return (
    <ThemeFrame theme={theme === "dark" ? "dark" : "light"}>
      {/* pink 테마는 data-theme="pink" 로 설정 */}
      <div
        data-theme={theme !== "light" && theme !== "dark" ? theme : undefined}
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          padding: 16,
          gap: 8,
          background: "var(--bg)",
          color: "var(--fg)",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
        }}
        ref={(el) => {
          // pink 테마는 ThemeFrame 이 data-theme="light" 를 설정하므로 덮어쓴다.
          if (theme === "pink" && el) {
            document.documentElement.setAttribute("data-theme", "pink");
          }
        }}
      >
        <div style={{ opacity: 0.6, fontSize: 11 }}>{label}</div>
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <GraphCanvas graph={graph} currentPath={currentPath} />
        </div>
      </div>
    </ThemeFrame>
  );
}

// ── 빈 그래프 ────────────────────────────────────────────────────────

export const EmptyDark: Story = () => (
  <GraphStory theme="dark" graph={EMPTY_GRAPH} label="빈 그래프 · 다크" />
);

export const EmptyLight: Story = () => (
  <GraphStory theme="light" graph={EMPTY_GRAPH} label="빈 그래프 · 라이트" />
);

export const EmptyPink: Story = () => (
  <GraphStory theme="pink" graph={EMPTY_GRAPH} label="빈 그래프 · 핑크" />
);

// ── 작은 그래프 (3 노드 직선 체인) ───────────────────────────────────

export const SmallDark: Story = () => (
  <GraphStory theme="dark" graph={SMALL_GRAPH} label="작은 그래프 · 다크" currentPath="b.md" />
);

export const SmallLight: Story = () => (
  <GraphStory theme="light" graph={SMALL_GRAPH} label="작은 그래프 · 라이트" currentPath="b.md" />
);

export const SmallPink: Story = () => (
  <GraphStory theme="pink" graph={SMALL_GRAPH} label="작은 그래프 · 핑크" currentPath="b.md" />
);

// ── 허브 그래프 (허브 + 5 이웃 + 고립 노드) ──────────────────────────

export const HubDark: Story = () => (
  <GraphStory theme="dark" graph={HUB_GRAPH} label="허브 그래프 · 다크" currentPath="hub.md" />
);

export const HubLight: Story = () => (
  <GraphStory theme="light" graph={HUB_GRAPH} label="허브 그래프 · 라이트" currentPath="hub.md" />
);

export const HubPink: Story = () => (
  <GraphStory theme="pink" graph={HUB_GRAPH} label="허브 그래프 · 핑크" currentPath="hub.md" />
);
