import { GraphPanel } from "./GraphPanel";

// 그래프 설정 패널 워크벤치 — 섹션 접기/펼치기, 슬라이더, 그룹 추가/삭제를
// 라이트/다크 테마에서 눈으로 확인한다 (설정은 localStorage에 저장된다).
export const Default = () => (
  <div
    style={{
      position: "relative",
      width: 480,
      height: 460,
      background: "var(--bg, #1e1e22)",
      borderRadius: 12,
    }}
  >
    <GraphPanel />
  </div>
);
Default.storyName = "그래프 설정 패널";
