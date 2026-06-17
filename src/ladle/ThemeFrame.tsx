// 스토리에서 앱 테마(라이트/다크)를 입히고 뷰어가 꽉 차게 들어갈 컨테이너를
// 제공한다. 앱은 :root[data-theme="light"] 로 라이트를, 속성 없음(기본 :root)으로
// 다크를 적용하므로 documentElement 속성만 토글하면 실제와 동일하게 보인다.
import { useLayoutEffect, type ReactNode } from "react";

export function ThemeFrame({
  theme,
  children,
}: {
  theme: "light" | "dark";
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const el = document.documentElement;
    const prev = el.getAttribute("data-theme");
    el.setAttribute("data-theme", theme);
    return () => {
      if (prev === null) el.removeAttribute("data-theme");
      else el.setAttribute("data-theme", prev);
    };
  }, [theme]);

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex" }}>{children}</div>
  );
}
