// Excalidraw 손글씨 폰트를 public/ 으로 복사한다.
//
// Excalidraw는 캔버스 텍스트 렌더링에 쓸 폰트를 런타임에 window.EXCALIDRAW_ASSET_PATH
// 기준으로 불러온다 (미설정 시 esm.sh CDN). 오프라인(Tauri WebView) 환경에서도
// 동작하도록 폰트를 앱 번들에 포함시키고, ExcalidrawEditor가 자산 경로를
// "/excalidraw-assets/" 로 고정한다. → 폰트는 /excalidraw-assets/fonts/* 로 서빙된다.
//
// predev/prebuild 에서 호출된다. 복사본은 .gitignore 처리(바이너리, node_modules 파생).

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(
  projectRoot,
  "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
);
const dest = resolve(projectRoot, "public/excalidraw-assets/fonts");

if (!existsSync(src)) {
  // 의존성 미설치 등 비정상 상태 — 빌드를 막지 않고 경고만 한다 (폰트는 CDN으로 폴백).
  console.warn(`[excalidraw-assets] fonts not found at ${src}; skipping copy`);
  process.exit(0);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[excalidraw-assets] copied fonts -> ${dest}`);
