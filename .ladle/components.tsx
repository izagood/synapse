// Ladle 전역 Provider. 모든 스토리에 앱 스타일시트를 입혀 CSS 변수/테마가
// 실제 앱과 동일하게 적용되도록 한다. (테마 토글은 스토리별 ThemeFrame 이 담당.)
import type { GlobalProvider } from "@ladle/react";
import "../src/app/styles.css";

export const Provider: GlobalProvider = ({ children }) => <>{children}</>;
