# PDF 그림판 기능 확장 설계

> 상태: 초안(리뷰 대기) · 대상: `src/features/pdf-draw/`, `src/features/pdf-viewer/`
> 목표: 현재 "자유곡선 필기" 전용 구조를 **객체 기반 그림판**으로 일반화하고,
> 도형·텍스트·이미지·선택편집·커스텀 스타일을 단계적으로 얹는다.

---

## 1. 현재 구조 요약 (출발점)

코드는 작고 잘 분리돼 있어 확장 토대가 좋다. 4개의 결합 지점만 이해하면 된다.

| 관심사 | 파일 | 핵심 |
|--------|------|------|
| **데이터 모델** | `drawDoc.ts` | `Stroke`(점 배열) 단일 타입 · `DrawDoc.pages[n] = Stroke[]` |
| **상태/영속화** | `usePdfDraw.ts` | 사이드카 `{pdf}.draw.json` 자동저장 · 페이지 단위 Undo 스냅샷 |
| **렌더** | `renderStrokes.ts` | 페이지별 오버레이 캔버스에 `drawStroke` 반복 |
| **입력** | `PdfViewer.tsx` `onDown/Move/Up` | 포인터 → scale1 좌표 → 진행 중 Stroke 수집 |
| **베이크** | `bakePdf.ts` | `strokeToSvgPath` + pdf-lib `drawSvgPath` |
| **UI** | `PdfDrawToolbar.tsx` | 4도구 · 6색 고정 · 3굵기 고정 |

### 설계상 가장 중요한 자산: 좌표계

모든 좌표·굵기가 **scale 1 페이지 좌표**(pdf.js `getViewport({scale:1})`, 원점 좌상단,
y 아래 방향, 단위 pt)로 저장된다. 줌·DPR과 무관하게 같은 위치를 가리키므로,
**도형/텍스트/이미지도 이 좌표계에 그대로 얹으면 렌더·저장·베이크가 전부 일관**된다.
이 추상화 덕분에 객체 모델로의 일반화 비용이 낮다.

### 가장 큰 제약: 모델이 Stroke에 고정

`DrawDoc.pages[n]: Stroke[]` 이고 `Stroke`는 자유곡선 점 배열만 표현한다.
도형·텍스트·이미지·선택 같은 "객체" 개념이 없다. 이걸 푸는 게 본 설계의 핵심.

---

## 2. 목표 데이터 모델 — `Shape` 유니온

`Stroke`를 `Shape` 판별 유니온(discriminated union)으로 일반화한다.
모든 Shape는 공통 메타(id, z-순서는 배열 순서)를 갖고, `type`으로 분기한다.

```ts
// 공통 베이스
interface ShapeBase {
  id: string;            // 안정적 식별자 (선택/이동/삭제 대상)
  type: ShapeType;
  // 스타일은 종류별로 의미가 달라 각 Shape가 필요한 것만 가진다.
}

type ShapeType = "path" | "line" | "arrow" | "rect" | "ellipse" | "text" | "image";

// 1) 자유곡선 — 기존 Stroke 계승 (pen/highlighter)
interface PathShape extends ShapeBase {
  type: "path";
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  opacity?: number;       // 신규: 불투명도 커스텀(없으면 도구 기본값)
  points: number[];       // [x0,y0,x1,y1,...]
  pressures?: number[];   // 신규(선택): 점별 필압 0..1 — 가변 굵기
}

// 2) 직선/화살표
interface LineShape extends ShapeBase {
  type: "line" | "arrow";
  color: string;
  width: number;
  opacity?: number;
  a: [number, number];    // 시작점
  b: [number, number];    // 끝점
  arrowHead?: "end" | "both" | "none"; // arrow 전용
}

// 3) 사각형/타원
interface RectLikeShape extends ShapeBase {
  type: "rect" | "ellipse";
  stroke?: string;        // 테두리 색(없으면 테두리 없음)
  fill?: string;          // 채우기 색(없으면 투명)
  width: number;          // 테두리 굵기
  opacity?: number;
  radius?: number;        // rect 모서리 둥글기(pt)
  rect: [number, number, number, number]; // x,y,w,h (정규화된 bbox)
}

// 4) 텍스트
interface TextShape extends ShapeBase {
  type: "text";
  text: string;
  color: string;
  fontSize: number;       // pt
  fontFamily?: string;
  pos: [number, number];  // 좌상단 기준점
  maxWidth?: number;      // 줄바꿈 폭(없으면 무제한)
  opacity?: number;
}

// 5) 이미지
interface ImageShape extends ShapeBase {
  type: "image";
  src: string;            // 사이드카에 상대 경로 또는 data URI (4장에서 결정)
  rect: [number, number, number, number]; // x,y,w,h
  opacity?: number;
}

type Shape = PathShape | LineShape | RectLikeShape | TextShape | ImageShape;

interface DrawDoc {
  version: 2;             // v1 → v2 마이그레이션
  pages: Record<number, Shape[]>;
}
```

### 버전 마이그레이션 (v1 → v2)

- `parseDrawDoc`에서 `version`을 보고 분기.
- v1 문서: 각 `Stroke`를 `PathShape`(`type:"path"`, `id` 부여)로 승격.
- 저장은 항상 v2로. **하위 호환**: 구버전 앱이 v2를 열면 모르는 `type`은
  현재 `isValidStroke`처럼 "유효하지 않은 항목은 조용히 버림" 정책으로 무시
  → PDF 열람은 막지 않는다. (단 구버전에서 저장 시 객체 유실 위험은 릴리즈 노트에 명시.)

### 불변식 / 검증

- 파싱 시 각 Shape를 type별 검증기로 거른다(기존 `isValidStroke` 패턴 확장).
- 손상·미지 타입은 버리고 가능한 만큼 복구(현 정책 유지).
- 좌표는 계속 `round2`로 반올림 저장.

---

## 3. 렌더 파이프라인 일반화

`renderStrokes.ts` → `renderShapes.ts`(또는 동명 유지)로 일반화.

```ts
function drawShape(ctx, shape) {
  switch (shape.type) {
    case "path":    drawPath(ctx, shape); break;     // 기존 drawStroke + smoothing
    case "line":
    case "arrow":   drawLine(ctx, shape); break;
    case "rect":
    case "ellipse": drawRectLike(ctx, shape); break;
    case "text":    drawText(ctx, shape); break;
    case "image":   drawImage(ctx, shape); break;     // HTMLImageElement 캐시 필요
  }
}
```

- `redrawOverlay(canvas, shapes, scale, dpr, extra)` 시그니처는 그대로,
  내부에서 `drawShape`로 위임.
- **이미지 캐시**: `ImageShape.src` → `HTMLImageElement` 맵을 훅이 보유.
  로드 완료 시 해당 페이지 `redrawPage` 재호출(비동기 디코드).
- **곡선 스무딩**: `path`는 점을 직선으로 잇는 대신 Catmull-Rom→베지어 변환으로
  부드럽게. 베이크의 `strokeToSvgPath`도 동일 곡선식을 써야 화면=출력 일치
  (`C`/`Q` 커맨드 생성). → 화면·베이크 곡선 로직을 한 함수로 공유.
- **선택 표시 레이어**: 선택된 Shape의 bbox + 리사이즈 핸들은
  **드로잉과 별도 오버레이**(또는 같은 캔버스 최상단)에 그린다. 저장 대상 아님.

---

## 4. 입력 처리 (도구별 상호작용)

`PdfViewer.tsx`의 `onDown/Move/Up`을 **도구 디스패처**로 재구성한다.
현재는 pen/highlighter/eraser만 분기 → 각 도구를 "인터랙션 핸들러"로 추상화.

```ts
interface ToolHandler {
  onDown(ctx): void;
  onMove(ctx): void;
  onUp(ctx): void;
}
// ctx = { page, x, y(scale1), api, redrawPage, ... }
```

| 도구 | 인터랙션 |
|------|----------|
| pen/highlighter | 기존: 점 누적 → commit (PathShape) |
| line/arrow | down=시작점, move=끝점 프리뷰, up=commit |
| rect/ellipse | down=한 모서리, move=드래그 bbox 프리뷰, up=commit |
| text | down=클릭 위치에 편집용 `<textarea>` 오버레이 띄움 → blur 시 TextShape commit |
| image | 툴바/붙여넣기/드롭으로 추가 → 기본 위치에 ImageShape, 이후 select로 이동 |
| **select** (신규) | down=히트테스트로 Shape 선택 · 핸들 드래그=리사이즈 · 본체 드래그=이동 |
| eraser | 기존 유지(객체 단위 삭제) · 옵션: "획 지우개"/"객체 지우개" |

### 히트테스트 (select/eraser 공용)

- `path`: 기존 `strokeHitsPoint` 재사용.
- `line/arrow`: `distanceToSegment` 재사용.
- `rect/ellipse`: bbox 내부 또는 테두리 근접.
- `text/image`: bbox 내부.
- z-순서 역순으로 첫 히트 채택(맨 위 객체 우선).

### 텍스트 입력 처리

- 캔버스에 직접 입력 불가 → 클릭 위치에 절대배치 `<textarea>`(scale 반영 폰트크기)
  를 띄워 네이티브 편집, 확정 시 TextShape로 굳힌다.
- 더블클릭으로 기존 TextShape 재편집.

### 이미지 소스 정책 (저장 위치 결정 필요)

두 안 — **리뷰에서 결정**:
- (A) data URI를 사이드카 JSON에 인라인 → 단순하지만 JSON 비대/중복.
- (B) 이미지를 `{pdf}.draw.assets/` 폴더에 파일로 저장하고 상대경로 참조
  → JSON 가볍고 재사용 용이, 파일 관리(고아 정리) 필요. `write_binary_unique` 재활용 가능.
- **권장: (B)**. 노트앱 특성상 큰 이미지를 JSON에 넣으면 자동저장/파싱이 무거워짐.

---

## 5. 상태/영속화 (`usePdfDraw`) 변경

대부분 그대로 동작한다. 페이지 단위 스냅샷 Undo는 Shape 배열에도 그대로 유효.

추가/변경:
- **Redo 스택**: 현재 Undo만 있음. `redoRef` 추가, 새 변경 시 redo 클리어.
  (체감 효과 큼 · 난이도 낮음)
- **객체 변경 연산**: `updateShape(page, id, patch)`, `removeShape(page, id)`,
  `moveShape`, `bringToFront/sendToBack`(z-순서) — 전부 pushUndo 후 적용.
- **선택 상태**: `selectedId`(페이지+id)는 영속화 대상 아님 → 훅의 React state로.
- 자동저장/직렬화 라운딩 로직은 유지. 이미지(B안)는 별도 파일 I/O 경로 추가.

---

## 6. 베이크(`bakePdf.ts`) 확장

pdf-lib는 필요한 프리미티브를 이미 제공한다. type별 매핑:

| Shape | pdf-lib API |
|-------|-------------|
| path | `drawSvgPath`(스무딩 곡선 path 공유) — 현행 |
| line | `drawLine` 또는 `drawSvgPath` |
| arrow | `drawLine` + 화살촉 삼각형(`drawSvgPath`) |
| rect | `drawRectangle`(borderColor/color/borderWidth/rotate, 둥근모서리는 path) |
| ellipse | `drawEllipse` |
| text | `drawText`(폰트 임베드 필요 — **CJK 주의**, 아래) |
| image | `embedPng`/`embedJpg` + `drawImage` |

- Y축 변환(top-left→bottom-left)은 현행 방식(`y=pageHeight` 기준) 유지.
- **텍스트 CJK 폰트**: pdf-lib 기본 StandardFont는 한글 불가.
  한글 텍스트 베이크하려면 폰트 파일 임베드(`fontkit` + ttf subset) 필요 →
  텍스트 베이크는 별도 작업으로 분리(화면 미리보기/사이드카는 즉시 정확).
- 회전 페이지(rotation≠0) 미보정은 현행 한계 유지(별도 이슈).

---

## 7. UI / 툴바 (`PdfDrawToolbar`)

- **도구 추가**: select, line/arrow, rect/ellipse, text, image 버튼.
  도구가 늘어나므로 그룹핑/팝오버(도형 그룹 하위 메뉴) 검토.
- **색상 커스텀**: 고정 6색 + 컬러 피커(HSV/Hex 입력) + 최근 사용 색.
- **굵기 커스텀**: 3프리셋 + 슬라이더(1~50pt).
- **불투명도 슬라이더**: 형광펜 0.4 하드코딩 제거, 모든 도구에 적용.
- **필압 토글**: 태블릿/펜 입력 시 가변 굵기 on/off.
- 도구별 컨텍스트 옵션(예: rect 선택 시 채우기/테두리/둥글기)을 인스펙터로.

---

## 8. 단계별 구현 계획 (PR 분할)

각 PR은 독립적으로 릴리즈 가능하고 테스트를 동반한다(`drawDoc`/기하/직렬화는
순수 함수라 vitest 단위 테스트 용이).

**Phase 0 — 모델 일반화 (토대, 사용자 가시 변화 적음)**
- `Stroke` → `Shape` 유니온 도입, v1→v2 마이그레이션, 검증기 확장.
- 기존 pen/highlighter/eraser를 `path` 위에서 재구현(동작 동일).
- 렌더/베이크/입력을 디스패처 구조로 리팩터. **이 PR이 이후 모든 기능의 기반.**
- 테스트: 마이그레이션 라운드트립, type별 직렬화/파싱, 히트테스트.

**Phase 1 — 빠른 개선 (모델 위에서 저비용)**
- Redo, 색상/굵기/불투명도 커스텀, 곡선 스무딩, 필압.
- 데이터 모델은 Phase 0에서 이미 필드 준비됨.

**Phase 2 — 도형 도구**
- line/arrow/rect/ellipse 입력·렌더·베이크.
- 인스펙터(채우기/테두리/둥글기).

**Phase 3 — 선택/편집**
- select 도구: 히트테스트, 이동, 리사이즈 핸들, z-순서, 삭제.
- 복사/붙여넣기/그룹(여유 시).

**Phase 4 — 텍스트**
- TextShape 입력(textarea 오버레이)·렌더·재편집.
- 베이크는 CJK 폰트 임베드 후속(화면/사이드카는 먼저 완성).

**Phase 5 — 이미지**
- 붙여넣기/드롭, 4장 (B)안 에셋 저장, 렌더·베이크.

**Phase 6+ — 고급(장기)**
- 레이어, 스냅/정렬 가이드, 스탬프 라이브러리, 손그림 도형 인식.

---

## 9. 리스크 / 미결정 사항 (리뷰 포인트)

1. **이미지 저장 방식** — data URI(A) vs 에셋 폴더(B). 권장 B. → 결정 필요.
2. **텍스트 베이크 CJK 폰트** — 폰트 임베드 범위/용량. 우선 화면만 지원하고
   베이크는 후속으로 분리할지.
3. **v2 하위 호환** — 구버전 앱이 v2를 저장하면 객체 유실. 경고 UX 필요한가.
4. **성능** — 객체 수 증가 시 매 포인터 이벤트 전체 재렌더 비용. 더티 영역/
   객체 단위 부분 갱신이 필요해지는 임계 검토(현재는 페이지 전체 redraw).
5. **선택 핸들 좌표계** — 핸들은 화면 px 고정 크기가 자연스러움(줌 무관).
   scale1 저장 객체와 화면 핸들의 좌표 변환 지점 정리 필요.
6. **eraser 의미** — 객체 지우개(전체 삭제) vs 획 분할 지우개. 현행은 전자.

---

## 10. 한눈에 보는 변경 영향도

| 파일 | Phase 0 | 이후 |
|------|---------|------|
| `drawDoc.ts` | 모델·마이그레이션·검증·곡선식 (대) | type별 추가 |
| `renderStrokes.ts` | `drawShape` 디스패처 (중) | type별 렌더 |
| `usePdfDraw.ts` | Shape 연산·Redo (중) | 객체 편집 연산 |
| `PdfViewer.tsx` | 입력 디스패처 (중) | 도구별 핸들러·select |
| `bakePdf.ts` | 디스패처 (중) | type별 매핑 |
| `PdfDrawToolbar.tsx` | (소) | 도구·인스펙터·피커 (대) |
| 신규 | — | `ColorPicker`, `Inspector`, 이미지 에셋 I/O |
