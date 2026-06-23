// Excalidraw 에디터의 UI 검증(Ladle 스토리 · Playwright E2E)과 mock 백엔드
// 시드(src/ipc/mock.ts)가 공유하는 샘플 `.excalidraw` 장면. drawio fixtures 와
// 같은 의도 — 스토리·E2E·mock 이 같은 입력을 보도록 한 곳에서만 정의한다.

// 1x1 투명 PNG. 임베드된 이미지 자산(files)이 저장·재로드 라운드트립에서
// 보존되는지 검증하기 위한 최소 데이터. 시각적으로는 거의 안 보이지만,
// files 키와 dataURL 이 살아남는지를 단위테스트로 못 박는 게 목적이다.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA0eDmBQAAAABJRU5ErkJggg==";

// 결정적(매번 동일) 타임스탬프 — 테스트 스냅샷 안정성을 위해 고정한다.
const FIXED_TS = 1_700_000_000_000;

/**
 * 사각형 1개 + 임베드 이미지 1개가 있는 정상 장면. 색을 명시해 다크 캔버스
 * 회귀(검정-위-검정)도 스크린샷으로 드러나고, image 요소 + files 항목으로
 * 이미지 자산 라운드트립을 함께 검증한다. 좌표/기본값은 Excalidraw restore()
 * 가 더 채우므로 최소한만 둔다.
 */
export const SAMPLE_EXCALIDRAW_JSON = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "rect-1",
        type: "rectangle",
        x: 120,
        y: 120,
        width: 200,
        height: 100,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "#a5d8ff",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
      {
        id: "img-1",
        type: "image",
        x: 360,
        y: 120,
        width: 80,
        height: 80,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 2,
        version: 1,
        versionNonce: 2,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        fileId: "sample-img",
        status: "saved",
        scale: [1, 1],
      },
    ],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {
      "sample-img": {
        mimeType: "image/png",
        id: "sample-img",
        dataURL: TINY_PNG_DATA_URL,
        created: FIXED_TS,
        lastRetrieved: FIXED_TS,
      },
    },
  },
  null,
  2,
);

/**
 * 요소가 하나도 없는 빈 장면. 에디터가 깨지지 않고(에러 텍스트 없이) 빈 캔버스로
 * 떠야 한다. emptySceneJson() 과 같은 골격이되 fixtures 로 따로 두어 스토리/E2E
 * 가 명시적으로 참조하게 한다.
 */
export const BLANK_EXCALIDRAW_JSON = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  },
  null,
  2,
);
