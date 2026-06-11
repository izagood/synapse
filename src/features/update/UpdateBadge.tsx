import { useUpdate } from "../../stores/update";

// 상태바 우측: 새 버전이 있을 때만 나타나는 원클릭 업데이트 버튼 (F2)
// 자동 확인은 앱 전역의 UpdateToast가 담당한다.
export function UpdateBadge() {
  const { available, installing, install } = useUpdate();

  if (!available) return null;

  return (
    <button
      className="update-badge"
      disabled={installing}
      onClick={() => void install()}
      title={`v${available} 다운로드 후 자동 재시작됩니다`}
    >
      {installing ? "설치 중… 곧 재시작됩니다" : `⬆ v${available} 업데이트`}
    </button>
  );
}
