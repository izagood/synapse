// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  GRAPH_VIEW_DEFAULTS,
  normalizeGraphViewSettings,
  useGraphView,
} from "./graphView";

beforeEach(() => {
  localStorage.clear();
  useGraphView.getState().reset();
});

describe("graphView 설정 스토어", () => {
  it("기본값: 태그 표시, 고립 숨김, 배율 1", () => {
    const s = useGraphView.getState().settings;
    expect(s.filters).toEqual({
      query: "",
      showTags: true,
      showOrphans: false,
      localDepth: 0,
    });
    expect(s.forces).toEqual({ repulsion: 1, linkDistance: 1, gravity: 1 });
    expect(s.display).toEqual({ nodeScale: 1, linkThickness: 1 });
    expect(s.groups).toEqual([]);
  });

  it("부분 패치가 병합되고 localStorage에 저장된다", () => {
    useGraphView.getState().update({ filters: { showOrphans: true } });
    expect(useGraphView.getState().settings.filters.showOrphans).toBe(true);
    expect(useGraphView.getState().settings.filters.showTags).toBe(true); // 기존 값 유지
    const raw = JSON.parse(localStorage.getItem("synapse.graphView")!);
    expect(raw.filters.showOrphans).toBe(true);
  });

  it("normalize: 손상 데이터는 기본값으로, 범위 밖 배율은 클램프", () => {
    expect(normalizeGraphViewSettings(null)).toEqual(GRAPH_VIEW_DEFAULTS);
    const s = normalizeGraphViewSettings({ forces: { repulsion: 99 } });
    expect(s.forces.repulsion).toBe(4);
    expect(s.forces.linkDistance).toBe(1);
  });

  it("normalize: 그룹은 형태가 온전한 항목만 남긴다", () => {
    const s = normalizeGraphViewSettings({
      groups: [
        { id: "1", query: "tag:ai", color: "#ff0000" },
        { id: 2, query: "잘못된 id" },
        "문자열",
      ],
    });
    expect(s.groups).toEqual([{ id: "1", query: "tag:ai", color: "#ff0000" }]);
  });

  it("reset은 기본값 복원 + 저장", () => {
    useGraphView.getState().update({ display: { nodeScale: 2 } });
    useGraphView.getState().reset();
    expect(useGraphView.getState().settings).toEqual(GRAPH_VIEW_DEFAULTS);
    const raw = JSON.parse(localStorage.getItem("synapse.graphView")!);
    expect(raw).toEqual(GRAPH_VIEW_DEFAULTS);
  });
});
