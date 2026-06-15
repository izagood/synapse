import { describe, expect, it } from "vitest";
import { parseRemoteConnectError } from "./ipc";

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
