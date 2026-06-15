import { describe, expect, it } from "vitest";
import { buildSshUri } from "./RemoteConnect";

describe("buildSshUri", () => {
  it("omits the default port 22", () => {
    expect(buildSshUri("me", "host.example", "22", "/srv/notes")).toBe(
      "ssh://me@host.example/srv/notes",
    );
  });

  it("includes a non-default port", () => {
    expect(buildSshUri("me", "host", "2222", "/srv")).toBe(
      "ssh://me@host:2222/srv",
    );
  });

  it("leaves an empty path for the remote home", () => {
    expect(buildSshUri("me", "host", "22", "")).toBe("ssh://me@host");
  });

  it("prefixes a relative path with a slash", () => {
    expect(buildSshUri("me", "host", "22", "notes")).toBe(
      "ssh://me@host/notes",
    );
  });

  it("brackets an IPv6 literal host", () => {
    expect(buildSshUri("me", "2001:db8::1", "22", "/srv")).toBe(
      "ssh://me@[2001:db8::1]/srv",
    );
  });

  it("trims whitespace in fields", () => {
    expect(buildSshUri(" me ", " host ", "22", " /srv ")).toBe(
      "ssh://me@host/srv",
    );
  });
});
