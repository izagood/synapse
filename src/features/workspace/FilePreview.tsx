import { useWorkspace } from "../../stores/workspace";

// M0: 읽기 전용 미리보기. M1에서 Tiptap 에디터, M2에서 HTML 렌더러로 대체된다.
export function FilePreview() {
  const { selectedPath, fileContent, error } = useWorkspace();

  if (!selectedPath) {
    return (
      <div className="preview-placeholder">
        <p>왼쪽에서 파일을 선택하세요</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="preview-placeholder">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (fileContent === null) {
    return (
      <div className="preview-placeholder">
        <p>불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="preview">
      <div className="preview-path">{selectedPath}</div>
      <pre className="preview-content">{fileContent}</pre>
    </div>
  );
}
