import { describe, expect, it } from "vitest";
import { detectDesktopPlatform, shortcutLabel } from "./platform";

describe("platform helpers", () => {
  it("detects desktop platforms from user agent", () => {
    expect(detectDesktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "macos",
    );
    expect(detectDesktopPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "windows",
    );
    expect(detectDesktopPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("formats shortcut labels per platform", () => {
    expect(shortcutLabel(["Shift", "Mod", "A"], "macos")).toBe("⇧⌘A");
    expect(shortcutLabel(["Shift", "Mod", "A"], "windows")).toBe("Shift+Ctrl+A");
    expect(shortcutLabel(["Mod", ","], "linux")).toBe("Ctrl+,");
  });
});
