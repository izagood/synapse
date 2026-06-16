import { resolveAssetUrl } from "../../ipc/ipc";

// PDF는 바이너리라 텍스트로 읽지 않는다. 워크스페이스 루트는 열릴 때
// asset protocol 스코프에 등록되므로(list_workspace), 파일을 asset URL로
// 변환해 iframe에 직접 띄운다. WebView(WKWebView/WebView2)가 PDF를
// 네이티브로 렌더링한다 — 페이지 이동·확대·텍스트 선택 모두 기본 제공.
export function PdfViewer({ path }: { path: string }) {
  return (
    <iframe className="pdf-viewer" title={path} src={resolveAssetUrl(path)} />
  );
}
