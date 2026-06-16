# drawio editor (vendored)

- Source: https://github.com/jgraph/drawio (`src/main/webapp`)
- Version: 30.0.4 (tag `v30.0.4`)
- License: Apache License 2.0 (https://github.com/jgraph/drawio/blob/dev/LICENSE)

`.drawio` 다이어그램을 오프라인에서 **편집**하기 위해 drawio 웹앱을 그대로
번들로 포함한다(embed 모드, `index.html?embed=1&proto=json`). 옆 디렉터리의
read-only 뷰어(`../drawio/viewer-static.min.js`)와 같은 버전이다.

전체 `src/main/webapp`(약 151MB)을 다 넣지 않고, 프로덕션 로드 체인
(`bootstrap.js` → `app.min.js` → `extensions.min.js` → `stencils.min.js` →
`shapes-14-6-5.min.js`)과 런타임에 필요한 자산만 추렸다:

- `index.html`, `favicon.ico`
- `js/` — bootstrap, main, PreConfig, PostConfig + 위 4개 프로덕션 번들
- `styles/`, `images/`, `mxgraph/{images,css}`
- `resources/` — 영어 base(`dia.txt`)와 한국어(`dia_ko.txt`)만

제외한 것(미니파이 번들에 이미 포함되거나 사용하지 않음): raw `stencils/`·
`shapes/`·`mxgraph/src/`, `integrate.min.js`/`viewer*.min.js` 등 대체 번들,
`templates/`, `math4/`, 클라우드 스토리지/통합용 html·`connect/`·`plugins/`,
서비스 워커, `WEB-INF/`·`META-INF/`, 영어·한국어 외 언어팩.

업데이트 시: `jgraph/drawio` 를 같은 태그로 sparse checkout 한 뒤
`src/main/webapp` 에서 위 목록만 같은 경로로 교체하고, 뷰어 번들 버전과 함께
이 버전을 갱신한다.
