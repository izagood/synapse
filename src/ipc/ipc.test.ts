import { describe, expect, it } from "vitest";
import { parseRemoteConnectError } from "./ipc";
import { mockIpc } from "./mock";

describe("parseRemoteConnectError", () => {
  it("classifies an unknown host key with its fingerprint", () => {
    const err = parseRemoteConnectError("UNKNOWN_HOST_KEY:SHA256:abc123");
    expect(err).toEqual({ kind: "unknownHostKey", fingerprint: "SHA256:abc123" });
  });

  it("classifies a host key mismatch", () => {
    const err = parseRemoteConnectError("HOST_KEY_MISMATCH:SHA256:deadbeef");
    expect(err).toEqual({
      kind: "hostKeyMismatch",
      fingerprint: "SHA256:deadbeef",
    });
  });

  it("falls back to a generic message for other errors", () => {
    expect(parseRemoteConnectError("인증 실패: ...")).toEqual({
      kind: "generic",
      message: "인증 실패: ...",
    });
  });

  it("reads the message from an Error instance", () => {
    expect(parseRemoteConnectError(new Error("연결 실패: timeout"))).toEqual({
      kind: "generic",
      message: "연결 실패: timeout",
    });
  });
});

// PDF 주석 사이드카의 숨김 경로 저장·레거시 폴백·이전 정책을 mockIpc(=Rust 정책 미러)로 검증.
describe("PDF 주석 사이드카 IPC (mock)", () => {
  const root = "/mock/notes";

  it("주석을 숨김 경로(.synapse/draw)에 쓰고 PDF 옆에는 두지 않는다", async () => {
    const pdf = `${root}/docs/report.pdf`;
    await mockIpc.writePdfDraw(root, pdf, '{"version":1,"pages":{}}');

    // 새 위치로 다시 읽힌다.
    expect(await mockIpc.readPdfDraw(root, pdf)).toBe('{"version":1,"pages":{}}');
    // 숨김 경로에 실제로 저장된다.
    expect(await mockIpc.readFile(root, `${root}/.synapse/draw/docs/report.pdf.draw.json`)).toBe(
      '{"version":1,"pages":{}}',
    );
    // PDF 옆 레거시 경로에는 파일이 없다.
    await expect(mockIpc.readFile(root, `${pdf}.draw.json`)).rejects.toThrow();
  });

  it("새 경로가 없으면 기존 PDF옆 사이드카를 폴백으로 읽고, 한 번 저장하면 레거시를 삭제한다", async () => {
    const pdf = `${root}/legacy.pdf`;
    // 기존(레거시) 사이드카만 존재하는 상태를 만든다.
    await mockIpc.writeFile(root, `${pdf}.draw.json`, '{"version":1,"pages":{"1":[]}}');

    // 폴백으로 읽힌다.
    expect(await mockIpc.readPdfDraw(root, pdf)).toBe('{"version":1,"pages":{"1":[]}}');

    // 저장하면 숨김 경로로 이전되고 레거시는 사라진다.
    await mockIpc.writePdfDraw(root, pdf, '{"version":1,"pages":{}}');
    await expect(mockIpc.readFile(root, `${pdf}.draw.json`)).rejects.toThrow();
    expect(await mockIpc.readFile(root, `${root}/.synapse/draw/legacy.pdf.draw.json`)).toBe(
      '{"version":1,"pages":{}}',
    );
  });

  it("주석이 전혀 없으면 reject 한다(호출측이 빈 문서로 처리)", async () => {
    await expect(mockIpc.readPdfDraw(root, `${root}/none.pdf`)).rejects.toThrow();
  });
});
