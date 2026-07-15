export type DesktopPlatform = "macos" | "windows" | "linux";

export function detectDesktopPlatform(userAgent = navigator.userAgent): DesktopPlatform {
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macos";
  if (/Windows/.test(userAgent)) return "windows";
  return "linux";
}

export function shortcutLabel(keys: string[], platform = detectDesktopPlatform()): string {
  const mac = platform === "macos";
  const tokens: Record<string, string> = mac
    ? { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" }
    : { Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl" };
  return keys.map((key) => tokens[key] ?? key).join(mac ? "" : "+");
}
