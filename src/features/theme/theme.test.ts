// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyTheme,
  effectiveBaseTheme,
  hexToRgba,
  isHexColor,
  nativeWindowTheme,
} from "./theme";

describe("effectiveBaseTheme", () => {
  it("returns preset themes as-is", () => {
    expect(effectiveBaseTheme("light")).toBe("light");
    expect(effectiveBaseTheme("dark")).toBe("dark");
    expect(effectiveBaseTheme("pink")).toBe("pink");
  });

  it("falls back to dark for system without matchMedia", () => {
    // jsdom 기본 환경에는 matchMedia가 없어 dark로 환원된다
    expect(effectiveBaseTheme("system")).toBe("dark");
  });
});

describe("nativeWindowTheme", () => {
  it("maps system to null and pink to light", () => {
    expect(nativeWindowTheme("system")).toBeNull();
    expect(nativeWindowTheme("light")).toBe("light");
    expect(nativeWindowTheme("dark")).toBe("dark");
    expect(nativeWindowTheme("pink")).toBe("light");
  });
});

describe("isHexColor", () => {
  it("accepts #rgb and #rrggbb only", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#ff66aa")).toBe(true);
    expect(isHexColor("ff66aa")).toBe(false);
    expect(isHexColor("rgb(1,2,3)")).toBe(false);
    expect(isHexColor("#ff66a")).toBe(false);
  });
});

describe("hexToRgba", () => {
  it("converts 6-digit and 3-digit hex", () => {
    expect(hexToRgba("#ff66aa", 0.18)).toBe("rgba(255, 102, 170, 0.18)");
    expect(hexToRgba("#f6a", 0.18)).toBe("rgba(255, 102, 170, 0.18)");
  });
});

describe("applyTheme", () => {
  it("sets data-theme from the resolved base theme", () => {
    const el = document.createElement("div");
    applyTheme(el, "pink");
    expect(el.getAttribute("data-theme")).toBe("pink");
  });

  it("applies custom color overrides as inline vars and derives accent-soft", () => {
    const el = document.createElement("div");
    applyTheme(el, "dark", { accent: "#ff66aa", bg: "#101010" });
    expect(el.style.getPropertyValue("--accent")).toBe("#ff66aa");
    expect(el.style.getPropertyValue("--bg")).toBe("#101010");
    expect(el.style.getPropertyValue("--accent-soft")).toBe("rgba(255, 102, 170, 0.18)");
  });

  it("ignores invalid hex values", () => {
    const el = document.createElement("div");
    applyTheme(el, "dark", { accent: "not-a-color" });
    expect(el.style.getPropertyValue("--accent")).toBe("");
  });

  it("clears previous overrides when re-applied without them", () => {
    const el = document.createElement("div");
    applyTheme(el, "dark", { accent: "#ff66aa" });
    applyTheme(el, "light", {});
    expect(el.getAttribute("data-theme")).toBe("light");
    expect(el.style.getPropertyValue("--accent")).toBe("");
    expect(el.style.getPropertyValue("--accent-soft")).toBe("");
  });
});
