// 바이너리 ↔ base64 변환 순수 헬퍼. 에디터 이미지 삽입과 파일 트리
// 드래그앤드롭 가져오기가 함께 쓴다(스토어 ↔ 에디터 순환 의존을 피하려고
// features 밖, shared 에 둔다).

/** ArrayBuffer를 base64 문자열로 (청크 단위 — 큰 파일에서 스택 폭주 방지) */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 큰 파일도 안전하게 base64로 (청크 변환) */
export async function fileToBase64(file: Blob): Promise<string> {
  return arrayBufferToBase64(await file.arrayBuffer());
}
