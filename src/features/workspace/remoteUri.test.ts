import { describe, it, expect } from "vitest";
import {
  splitRemoteUri,
  joinRemoteUri,
  posixDirname,
  posixJoin,
} from "./remoteUri";

describe("splitRemoteUri", () => {
  it("권한부와 경로를 나눈다", () => {
    expect(splitRemoteUri("ssh://me@host/home/me")).toEqual({
      base: "ssh://me@host",
      path: "/home/me",
    });
  });

  it("포트가 있는 권한부도 보존한다", () => {
    expect(splitRemoteUri("ssh://me@host:2222/srv/notes")).toEqual({
      base: "ssh://me@host:2222",
      path: "/srv/notes",
    });
  });

  it("IPv6 리터럴 호스트의 대괄호를 경로로 오인하지 않는다", () => {
    expect(splitRemoteUri("ssh://me@[2001:db8::1]:22/srv")).toEqual({
      base: "ssh://me@[2001:db8::1]:22",
      path: "/srv",
    });
  });

  it("경로가 없으면 루트로 본다", () => {
    expect(splitRemoteUri("ssh://me@host")).toEqual({
      base: "ssh://me@host",
      path: "/",
    });
  });
});

describe("joinRemoteUri", () => {
  it("split 의 역연산이다", () => {
    const uri = "ssh://me@host:2222/srv/notes";
    const { base, path } = splitRemoteUri(uri);
    expect(joinRemoteUri(base, path)).toBe(uri);
  });

  it("선행 슬래시가 없는 경로도 붙인다", () => {
    expect(joinRemoteUri("ssh://me@host", "srv")).toBe("ssh://me@host/srv");
  });
});

describe("posixDirname", () => {
  it("부모 디렉터리를 돌려준다", () => {
    expect(posixDirname("/home/me/docs")).toBe("/home/me");
  });

  it("한 단계 경로의 부모는 루트", () => {
    expect(posixDirname("/home")).toBe("/");
  });

  it("루트의 부모는 루트", () => {
    expect(posixDirname("/")).toBe("/");
  });

  it("끝 슬래시를 무시한다", () => {
    expect(posixDirname("/home/me/")).toBe("/home");
  });
});

describe("posixJoin", () => {
  it("세그먼트를 잇는다", () => {
    expect(posixJoin("/home/me", "docs")).toBe("/home/me/docs");
  });

  it("루트에 잇는다", () => {
    expect(posixJoin("/", "docs")).toBe("/docs");
  });
});
