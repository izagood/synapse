import type { Editor } from "@tiptap/core";
import { ipc } from "../../ipc/ipc";
import { useWorkspace } from "../../stores/workspace";

/** 큰 파일도 안전하게 base64로 (청크 변환) */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 클립보드 이미지는 이름이 없으니 랜덤 생성 (예: image-mbz3k1-x4f2a.png) */
export function pastedImageName(mimeType: string): string {
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const rand = Math.random().toString(36).slice(2, 7);
  return `image-${Date.now().toString(36)}-${rand}.${ext}`;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * CommonMark는 `![alt](목적지)`의 목적지에 공백을 허용하지 않으므로
 * (macOS 스크린샷 기본 이름 "스크린샷 2026-… 오후 3.24.15.png" 등)
 * 공백을 -로 치환해 재오픈 시 이미지가 텍스트로 깨지는 것을 막는다.
 */
export function safeImageName(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}

/**
 * 이미지 파일들을 노트와 같은 폴더에 저장하고 에디터의 지정 위치에 삽입한다.
 * - 드래그앤드롭: 원본 파일명 유지 (공백은 -로 치환, 충돌 시 "이름 2.ext")
 * - 붙여넣기: 랜덤 파일명
 * 문서에는 상대 경로(파일명)로 기록되어 다른 도구와 호환된다 (NFR-3).
 */
export async function insertImages(
  editor: Editor,
  files: File[],
  notePath: string,
  position?: number,
): Promise<void> {
  const { root, refreshTree } = useWorkspace.getState();
  if (!root) return;
  const noteDir = notePath.slice(0, notePath.lastIndexOf("/"));

  let insertAt = position ?? editor.state.selection.to;
  for (const file of files) {
    const desired = safeImageName(
      file.name && file.name !== "image.png" ? file.name : pastedImageName(file.type),
    );
    const base64 = await fileToBase64(file);
    const savedName = await ipc.saveImage(root, noteDir, desired, base64);
    const alt = savedName.replace(/\.[^.]+$/, "");
    editor
      .chain()
      .insertContentAt(insertAt, { type: "image", attrs: { src: savedName, alt } })
      .focus()
      .run();
    insertAt = Math.min(insertAt + 1, editor.state.doc.content.size);
  }
  void refreshTree();
}
