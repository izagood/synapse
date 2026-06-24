/**
 * PTY 출력 디코드. 백엔드는 PTY 바이트를 그대로 base64로 감싸 보내므로
 * (UTF-8 경계 깨짐·이스케이프 시퀀스 손상 방지), 프론트는 base64를 바이트 배열로
 * 풀어 xterm에 그대로 쓴다.
 */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
