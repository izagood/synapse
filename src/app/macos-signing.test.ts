import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * macOS Developer ID 서명/공증 설정 회귀 방지.
 *
 * Hardened Runtime은 기본적으로 막는 게 많아서, entitlement 하나가 빠지면
 * 해당 기능이 예외 없이 "조용히" 실패한다 — 서명된 릴리스 빌드에서만
 * 드러나므로 개발 중에는 전혀 보이지 않는다. capabilities.test.ts와 같은
 * 방식으로, "소스에서 실제로 하는 일"과 "entitlements가 허용하는 것"을
 * 여기서 맞물려 검사한다.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const entitlements = read("src-tauri/entitlements.plist");
const infoPlist = read("src-tauri/Info.plist");
const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
  bundle?: { macOS?: { hardenedRuntime?: boolean; entitlements?: string } };
};

/** plist에서 <key>NAME</key> 다음에 오는 <true/> 여부 */
function hasTrueKey(plist: string, key: string): boolean {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<(true|false)/>`));
  return m?.[1] === "true";
}

/** Rust 쪽 소스를 한 덩어리로 (외부 프로세스 실행 등 실제 동작 확인용) */
const rustSources = [
  "src-tauri/src/commands.rs",
  "crates/synapse-core/src/external_terminal.rs",
  "crates/synapse-core/src/git.rs",
]
  .map(read)
  .join("\n");

describe("macOS 서명 설정 (tauri.conf.json)", () => {
  it("Hardened Runtime이 켜져 있다", () => {
    // 공증(notarization)의 전제 조건이다 — 꺼져 있으면 Apple이 거부한다.
    expect(tauriConf.bundle?.macOS?.hardenedRuntime).toBe(true);
  });

  it("entitlements 파일을 가리킨다", () => {
    // 경로가 틀리면 tauri가 조용히 entitlement 없이 서명해버린다.
    expect(tauriConf.bundle?.macOS?.entitlements).toBe("entitlements.plist");
  });

  it("signingIdentity를 설정 파일에 하드코딩하지 않는다", () => {
    // 인증서 없는 로컬 개발 빌드가 깨지지 않도록 APPLE_SIGNING_IDENTITY
    // 환경변수로만 주입한다.
    expect(tauriConf.bundle?.macOS).not.toHaveProperty("signingIdentity");
  });
});

describe("entitlements.plist", () => {
  it("WKWebView JIT을 허용한다", () => {
    // 없으면 웹뷰가 뜨지 않아 앱이 아예 실행 불가 상태가 된다.
    expect(hasTrueKey(entitlements, "com.apple.security.cs.allow-jit")).toBe(true);
  });

  it("네트워크 클라이언트를 허용한다", () => {
    // GitHub Device Flow 로그인·동기화·업데이터가 전부 여기에 달려 있다.
    expect(hasTrueKey(entitlements, "com.apple.security.network.client")).toBe(true);
  });

  it("외부 프로세스를 spawn하므로 라이브러리 검증을 끈다", () => {
    expect(
      rustSources.includes("Command::new"),
      '이 검사는 앱이 외부 프로세스를 실행한다는 전제로 존재한다. 그만뒀다면 규칙도 지운다.',
    ).toBe(true);
    expect(
      hasTrueKey(entitlements, "com.apple.security.cs.disable-library-validation"),
      "synapse-mcp 사이드카와 git·osascript는 Synapse와 다른 서명이라 라이브러리 검증에 걸린다",
    ).toBe(true);
  });

  it("App Sandbox를 켜지 않는다", () => {
    // 사용자가 고른 임의 경로의 노트 폴더를 직접 읽고 쓰는 앱이라
    // 샌드박스 모델과 맞지 않는다. 켜면 파일 접근이 전부 막힌다.
    expect(hasTrueKey(entitlements, "com.apple.security.app-sandbox")).toBe(false);
  });
});

describe("Apple Events (외부 터미널 열기)", () => {
  // entitlement와 Info.plist 설명 문자열은 짝이다. 둘 중 하나만 있으면
  // macOS가 권한 프롬프트를 띄우지 못해 기능이 조용히 실패한다.
  it("osascript로 터미널을 여는 코드가 있다", () => {
    expect(
      rustSources.includes("osascript"),
      "이 검사는 external_terminal.rs가 osascript를 쓴다는 전제로 존재한다. 그만뒀다면 아래 두 규칙과 함께 지운다.",
    ).toBe(true);
  });

  it("apple-events entitlement가 있다", () => {
    expect(hasTrueKey(entitlements, "com.apple.security.automation.apple-events")).toBe(true);
  });

  it("Info.plist에 NSAppleEventsUsageDescription이 있다", () => {
    expect(infoPlist).toContain("NSAppleEventsUsageDescription");
    // 빈 문자열이면 macOS가 프롬프트를 띄우지 않는다 — 사용자에게 보이는 문구다.
    const m = infoPlist.match(
      /<key>NSAppleEventsUsageDescription<\/key>\s*<string>([^<]*)<\/string>/,
    );
    expect(m?.[1]?.trim()).toBeTruthy();
  });
});
