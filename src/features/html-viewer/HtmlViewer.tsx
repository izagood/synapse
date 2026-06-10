import { useMemo } from "react";
import { resolveAssetUrl } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";
import { sanitizeHtml } from "./sanitize";

function resolveRelative(baseDir: string, rel: string): string {
  const cleaned = rel.replace(/^\.\//, "");
  return resolveAssetUrl(`${baseDir}/${cleaned}`);
}

// 정화된 HTML을 권한 없는 샌드박스 iframe(sandbox="")에 렌더링한다.
// 스크립트 실행/같은 출처 접근/팝업/폼 제출 모두 불가 (FR-3.2).
export function HtmlViewer({ path }: { path: string }) {
  const doc = useWorkspace((s) => s.docs[path]);
  const baseDir = path.slice(0, path.lastIndexOf("/"));

  const sanitized = useMemo(
    () =>
      sanitizeHtml(doc?.content ?? "", {
        resolveLocal: (rel) => resolveRelative(baseDir, rel),
      }),
    [doc?.content, baseDir],
  );

  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>
        body { margin: 24px auto; max-width: 860px; padding: 0 24px;
               font-family: -apple-system, "Pretendard", "Noto Sans KR", sans-serif;
               line-height: 1.7; background: #fff; color: #1a1a1a; }
        img { max-width: 100%; }
      </style></head><body>${sanitized}</body></html>`,
    [sanitized],
  );

  return (
    <iframe
      className="html-viewer"
      title={path}
      sandbox=""
      srcDoc={srcDoc}
    />
  );
}
