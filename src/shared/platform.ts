export type DesktopPlatform = "macos" | "windows" | "linux";

export function detectDesktopPlatform(userAgent = navigator.userAgent): DesktopPlatform {
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macos";
  if (/Windows/.test(userAgent)) return "windows";
  return "linux";
}

export function shortcutLabel(keys: string[], platform = detectDesktopPlatform()): string {
  const mod = platform === "macos" ? "⌘" : "Ctrl";
  const shift = platform === "macos" ? "⇧" : "Shift";
  return keys.map((key) => (key === "Mod" ? mod : key === "Shift" ? shift : key)).join(
    platform === "macos" ? "" : "+",
  );
}
