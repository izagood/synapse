// 경로/파일명 관련 순수 헬퍼. 여러 기능(워크스페이스 트리, mock, 파일
// 히스토리, 에이전트 컨텍스트 등)이 각자 인라인으로 같은 로직을 반복하던 것을
// 한 곳으로 모은다. Rust 쪽(synapse-core::tree)의 분류 규칙과 의미가 같다.

import type { FileType } from "../ipc/types";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

/** 파일명 확장자로 노트/HTML/PDF/이미지/드로잉/기타를 분류한다. (Rust tree::file_type_of 와 동일) */
export function fileTypeOf(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (ext === "excalidraw") return "excalidraw";
  if (ext && IMAGE_EXTS.has(ext)) return "image";
  if (ext === "drawio" || ext === "dio") return "drawio";
  return "other";
}

/** 경로의 마지막 구성요소(파일/폴더명)를 돌려준다. `/`와 `\` 모두 구분자로 본다. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** 파일명에서 마지막 확장자를 떼어낸다. 확장자가 없으면 그대로 둔다. */
export function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 루트 기준 상대 경로로 바꾼다. 루트 밖이면 절대 경로를 그대로 둔다. */
export function toRelativePath(root: string, path: string): string {
  if (path === root) return ".";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
