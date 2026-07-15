import { useState } from "react";
import { useT } from "../../i18n";
import { useGraphView, type GraphGroup } from "../../stores/graphView";
import { CloseIcon, PlusIcon, RefreshIcon } from "../../shared/Icons";

// 옵시디언 그래프 설정 패널 벤치마킹: Filters/Groups/Display/Forces 접이식 섹션.
// 상태는 전부 useGraphView 스토어 — 이 컴포넌트는 얇은 바인딩만 한다.

/** 기존 그룹과 겹치지 않는 결정적 id (난수·시각 미사용 — 결정성 원칙) */
function nextGroupId(groups: GraphGroup[]): string {
  let max = 0;
  for (const g of groups) {
    const m = /^g(\d+)$/.exec(g.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `g${max + 1}`;
}

/** 새 그룹 기본 색 팔레트 — 추가 순서대로 돌아가며 배정한다 */
const GROUP_COLORS = ["#7c5cff", "#2f9e64", "#d0342c", "#b8860b", "#2b7de9"];

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="graph-panel-section">
      <button
        className="graph-panel-section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span
          className={
            open ? "graph-panel-chevron graph-panel-chevron-open" : "graph-panel-chevron"
          }
        >
          ›
        </span>
        {title}
      </button>
      {open && <div className="graph-panel-section-body">{children}</div>}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="graph-panel-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function GraphPanel() {
  const t = useT();
  const settings = useGraphView((s) => s.settings);
  const update = useGraphView((s) => s.update);
  const reset = useGraphView((s) => s.reset);
  const { filters, groups, display, forces } = settings;

  return (
    <div className="graph-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="graph-panel-head">
        <span>{t("graph.panel")}</span>
        <button onClick={reset} title={t("graph.reset")} aria-label={t("graph.reset")}>
          <RefreshIcon size={13} />
        </button>
      </div>

      <Section title={t("graph.filters")}>
        <input
          type="text"
          className="graph-panel-query"
          value={filters.query}
          placeholder={t("graph.filterQuery")}
          spellCheck={false}
          onChange={(e) => update({ filters: { query: e.target.value } })}
        />
        <label className="graph-panel-check">
          <span>{t("graph.showTags")}</span>
          <input
            type="checkbox"
            checked={filters.showTags}
            onChange={(e) => update({ filters: { showTags: e.target.checked } })}
          />
        </label>
        <label className="graph-panel-check">
          <span>{t("graph.showOrphans")}</span>
          <input
            type="checkbox"
            checked={filters.showOrphans}
            onChange={(e) => update({ filters: { showOrphans: e.target.checked } })}
          />
        </label>
        <label className="graph-panel-select">
          <span>{t("graph.localGraph")}</span>
          <select
            value={filters.localDepth}
            onChange={(e) =>
              update({ filters: { localDepth: Number(e.target.value) as 0 | 1 | 2 } })
            }
          >
            <option value={0}>{t("graph.localOff")}</option>
            <option value={1}>{t("graph.localDepth1")}</option>
            <option value={2}>{t("graph.localDepth2")}</option>
          </select>
        </label>
      </Section>

      <Section title={t("graph.groups")}>
        {groups.map((g) => (
          <div key={g.id} className="graph-panel-group">
            <input
              type="color"
              value={g.color}
              aria-label={g.query || g.id}
              onChange={(e) =>
                update({
                  groups: groups.map((x) =>
                    x.id === g.id ? { ...x, color: e.target.value } : x,
                  ),
                })
              }
            />
            <input
              type="text"
              value={g.query}
              placeholder={t("graph.groupQueryPlaceholder")}
              spellCheck={false}
              onChange={(e) =>
                update({
                  groups: groups.map((x) =>
                    x.id === g.id ? { ...x, query: e.target.value } : x,
                  ),
                })
              }
            />
            <button
              onClick={() => update({ groups: groups.filter((x) => x.id !== g.id) })}
              title={t("graph.removeGroup")}
              aria-label={t("graph.removeGroup")}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
        <button
          className="graph-panel-add"
          onClick={() =>
            update({
              groups: [
                ...groups,
                {
                  id: nextGroupId(groups),
                  query: "",
                  color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
                },
              ],
            })
          }
        >
          <PlusIcon size={12} /> {t("graph.addGroup")}
        </button>
      </Section>

      <Section title={t("graph.display")}>
        <Slider
          label={t("graph.nodeScale")}
          value={display.nodeScale}
          min={0.5}
          max={2}
          onChange={(v) => update({ display: { nodeScale: v } })}
        />
        <Slider
          label={t("graph.linkThickness")}
          value={display.linkThickness}
          min={0.5}
          max={3}
          onChange={(v) => update({ display: { linkThickness: v } })}
        />
      </Section>

      <Section title={t("graph.forces")}>
        <Slider
          label={t("graph.repulsion")}
          value={forces.repulsion}
          min={0.25}
          max={4}
          onChange={(v) => update({ forces: { repulsion: v } })}
        />
        <Slider
          label={t("graph.linkDistance")}
          value={forces.linkDistance}
          min={0.25}
          max={4}
          onChange={(v) => update({ forces: { linkDistance: v } })}
        />
        <Slider
          label={t("graph.gravity")}
          value={forces.gravity}
          min={0.25}
          max={4}
          onChange={(v) => update({ forces: { gravity: v } })}
        />
      </Section>
    </div>
  );
}
