import React from "react";
import { translate } from "../i18n";
import { useSettings } from "../stores/settings";

// 렌더/커밋 중 동기 throw의 마지막 방어선. React 18은 경계가 없으면 root 전체를
// unmount해 아무 정보 없는 빈 화면이 된다(v0.5.42 앱 먹통 회귀). 경계는 원인
// 메시지와 복구 수단(다시 시작)을 남긴다.
//
// 클래스 컴포넌트인 이유: 에러 경계는 아직 클래스 전용 API다
// (getDerivedStateFromError). 훅을 못 쓰므로 언어는 store에서 직접 읽는다 —
// 설정 로드조차 실패한 크래시에서도 떠야 하므로 실패 시 ko로 폴백한다.
function crashText(key: "title" | "description" | "restart"): string {
  let language: string | null = null;
  try {
    language = useSettings.getState().settings.appearance.language;
  } catch {
    // 설정 store 접근 실패 — 기본 로케일로 폴백
  }
  return translate(language, `crash.${key}`);
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught render crash:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <h1>{crashText("title")}</h1>
        <p>{crashText("description")}</p>
        <pre className="crash-detail">{error.message}</pre>
        <button className="primary-btn" onClick={() => window.location.reload()}>
          {crashText("restart")}
        </button>
      </div>
    );
  }
}
