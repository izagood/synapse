// pdf.js 의 cmap·표준폰트를 public/pdfjs/ 로 복사한다.
//
// PDF에 폰트가 임베드돼 있지 않은 경우(특히 CJK), pdf.js 는 cMapUrl /
// standardFontDataUrl 기준으로 폰트 데이터를 런타임에 불러온다. 오프라인(Tauri
// WebView) 환경에서도 한글 등이 깨지지 않도록 앱 번들에 포함시키고, PdfViewer 가
// 자산 경로를 "/pdfjs/cmaps/", "/pdfjs/standard_fonts/" 로 고정한다.
//
// predev/prebuild 에서 호출된다. 복사본은 .gitignore 처리(바이너리, node_modules 파생).

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjsRoot = resolve(projectRoot, "node_modules/pdfjs-dist");
const destRoot = resolve(projectRoot, "public/pdfjs");

const jobs = [
  { src: resolve(pdfjsRoot, "cmaps"), dest: resolve(destRoot, "cmaps") },
  { src: resolve(pdfjsRoot, "standard_fonts"), dest: resolve(destRoot, "standard_fonts") },
];

if (!existsSync(pdfjsRoot)) {
  // 의존성 미설치 등 비정상 상태 — 빌드를 막지 않고 경고만 한다.
  console.warn(`[pdfjs-assets] pdfjs-dist not found at ${pdfjsRoot}; skipping copy`);
  process.exit(0);
}

await rm(destRoot, { recursive: true, force: true });
for (const { src, dest } of jobs) {
  if (!existsSync(src)) {
    console.warn(`[pdfjs-assets] not found at ${src}; skipping`);
    continue;
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`[pdfjs-assets] copied ${src} -> ${dest}`);
}
