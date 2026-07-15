# 편집 시 마크다운 포맷 바이트 보존 설계

## 배경 / 문제

synapse의 WYSIWYG 마크다운 에디터에서 문서를 편집·저장하면, 사용자가 **건드리지 않은 부분까지 포맷이 변형**되어 디스크에 저장된다.

원인은 저장 경로에 있다. `MarkdownEditor.tsx`의 `onUpdate`가 편집 때마다 `getMarkdown(editor)`로 **문서 전체를 tiptap-markdown 직렬화기로 재직렬화**하고, 그 정규화된 결과가 `doc.content` → `saveDoc`을 거쳐 그대로 파일에 기록된다. `crates/synapse-core/src/merge.rs`의 3-way 병합(`save_merge`)은 "외부 도구가 디스크를 바꿨을 때"만 흡수할 뿐, 이 재직렬화 정규화 자체는 막지 못한다.

실측으로 확인된 변형(문서: `rebel-compiler-분석.md`):

| 유형 | 원본 | 재직렬화 결과 | 성격 |
|------|------|---------------|------|
| 표 구분선 | `\|------\|------\|` | `\| --- \| --- \|` | 무해(렌더 동일) |
| 틸드 이스케이프 | `~3,500+` | `\~3,500+` | 무해 |
| soft break | 빈 줄 없는 인접 두 줄 | 한 줄로 병합 | 무해하나 바이트 변화 |
| 인접 이탤릭 | `*A*\n*B*` | `*AB*` (공백 소실·병합) | **데이터 손상** |

`roundtripSafety.ts`의 `hasRoundtripContentLoss`가 이 변형을 감지해 경고 배너를 띄우지만, 이는 증상 알림일 뿐 저장 자체는 정규화된 내용을 쓴다. (배너 문안이 "HTML" 을 예시하지만 이 문서엔 HTML이 없다 — 실제 트리거는 위 soft-break/이탤릭 병합이다.)

## 목표

**바이트 보존(전체):** 사용자가 실제로 편집한 블록만 재직렬화하고, 손대지 않은 블록은 원본 바이트를 그대로 유지한다.

- 불변식: 편집이 특정 블록에 국한되면, 그 외 블록은 저장 후에도 바이트 동일.
- 부수 효과: 손상·재포맷·불필요한 diff 노이즈 제거. 경고 배너 거짓 양성 자연 소멸.

비목표(YAGNI): 리스트 항목·표 셀 등 **블록 내부** 서브 요소 단위의 세밀 보존. 보존 단위는 top-level 블록으로 한다(필요 시 후속 확장).

## 접근

markdown-it는 top-level 블록 토큰마다 소스 라인 범위(`token.map = [startLine, endLine)`)를 제공한다(실측 확인). 이를 이용해 원본을 블록별 바이트로 슬라이스하고, 편집 후 직렬화 결과와 **블록 의미 시그니처**로 정렬(LCS)해, 의미가 같은 블록은 원본 바이트를, 변경/신규 블록은 직렬화 바이트를 출력한다.

"블록이 의미상 같은가"의 판정 기준은 이미 `roundtripSafety.ts`에 있는 토큰 시그니처 로직을 그대로 재사용한다. 손실 감지와 바이트 보존이 하나의 개념(시그니처 동등성)으로 통일된다.

## 컴포넌트

### 1. `roundtripSafety.ts` 리팩터 — 블록 단위 시그니처 노출

현재 문서 전체를 하나의 시그니처 배열로 만드는 `markdownSignature`를, **top-level 블록별로 그룹화한 시그니처**를 반환하도록 분해한다.

```ts
// 신규 export
export type BlockSignature = {
  sig: string;        // 블록 토큰 서브트리의 정규화 시그니처(JSON)
  startLine: number;  // 원본 본문에서의 시작 라인 (0-indexed)
  endLine: number;    // 끝 라인 (exclusive)
};
export function blockSignatures(markdown: string): BlockSignature[];
```

- markdown-it 파스 결과에서 `level === 0`이고 `map`이 있는 블록 경계를 기준으로 토큰을 그룹화.
- 각 그룹의 기존 `tokenSignature` 결과를 JSON 직렬화해 `sig`로.
- `hasRoundtripContentLoss`는 `blockSignatures(x).map(b => b.sig)` 비교로 재구현(동작 동일, 중복 제거).

### 2. 신규 `preserveFormatting.ts`

```ts
export function preserveFormatting(original: string, serialized: string): string;
```

알고리즘:
1. `original === serialized`(개행 정규화 후) → `original` 즉시 반환.
2. `O = blockSignatures(original)`, `N = blockSignatures(serialized)`.
3. `sig` 기준 LCS로 O·N 블록을 정렬 → 매칭 쌍(의미 동일) 집합.
4. 출력을 N 순서로 재구성:
   - N 블록이 O 블록과 매칭됨 → 해당 **O 블록의 원본 라인 슬라이스** 출력.
   - 매칭 안 됨(편집·신규) → 해당 **N 블록의 라인 슬라이스** 출력.
5. 블록 사이 구분(빈 줄): 연속으로 보존된 O 블록 사이에는 원본의 빈 줄을, 신규 블록 경계에는 표준 1빈 줄을 넣는다.
6. 끝 개행: 호출부(`keepNlRef`) 로직을 유지하되, 함수는 마지막 블록 뒤 원본 개행 패턴을 보존한다.

**불변식 보장:** O·N의 시그니처 열이 완전히 같으면 LCS가 전부 매칭 → 출력이 원본 라인들을 순서대로 이어붙인 것 = 원본과 바이트 동일.

### 3. `MarkdownEditor.tsx` 통합

`onUpdate`에서 재직렬화 직후 보존 단계를 삽입:

```ts
onUpdate({ editor }) {
  if (applyingExternal.current) return;
  let markdown = getMarkdown(editor);
  if (markdown === baseline.current) {
    updateContent(path, original.current); // 무편집 복원 (기존 유지)
    return;
  }
  const originalBody = splitFrontmatter(original.current).body;
  markdown = preserveFormatting(originalBody, markdown); // ← 신규
  if (keepNlRef.current && !markdown.endsWith("\n")) markdown += "\n";
  updateContent(path, joinFrontmatter(fmRef.current, markdown));
}
```

- 비교 기준은 **원본 본문 바이트**(`splitFrontmatter(original.current).body`) — baseline(직렬화형)이 아니다.
- 외부 리로드(`applyExternal`) 시 `original.current`/`baseline`이 갱신되므로 다음 편집부터 새 기준이 자연 적용.
- `lossy` 계산은 보존 결과 기준으로 바꿔 배너 거짓 양성 제거(선택: `hasRoundtripContentLoss(originalBody, preserved)`).

## 엣지 케이스

- **frontmatter**: `splitFrontmatter`로 본문만 처리, 재결합은 기존 `joinFrontmatter`.
- **펜스/표 내부 빈 줄**: `token.map`이 블록 전체를 감싸므로 라인 슬라이스로 온전 보존.
- **중복 시그니처 블록**(동일 문단 2개): LCS가 처리. 오분류돼도 원본·재직렬화 바이트가 동일이라 내용 안전.
- **블록 재정렬/삭제/삽입**: LCS 공통부 보존, 이동/신규 블록만 재직렬화(허용 범위).
- **블록 내부만 편집**: 그 블록 전체가 재직렬화됨(정규화). 목표 범위상 허용.
- **빈 문서 / 본문 없음**: 블록 0개 → 직렬화 결과 그대로.

## 테스트 (TDD)

`preserveFormatting.test.ts` (신규):
- 무편집: `preserveFormatting(x, roundtrip(x))`가 `x`와 바이트 동일(표·틸드·soft break·이탤릭 푸터 포함 문서).
- 단일 문단 편집: 한 문단에 단어 추가 → 그 문단 라인만 변하고 나머지 블록 전부 바이트 동일.
- 실제 `rebel-compiler-분석.md` 회귀: 한 곳 편집 시 표 구분선/틸드/푸터 이탤릭 보존.
- 블록 삽입/삭제: 나머지 원본 블록 바이트 보존.
- frontmatter + 끝 개행 상호작용.

`roundtripSafety.test.ts`: 기존 6 테스트 유지(리팩터 후 동작 불변) + `blockSignatures` 단위 테스트 추가.

`roundtrip.test.ts`: 기존 19 테스트 유지.

## 검증 / 릴리스

- 로컬: `npm run typecheck && npm test && npm run build`.
- 실기기 확인: 앱에서 표·이탤릭 섞인 문서 한 곳 편집 후 저장 → git diff가 편집 라인에만 국한되는지 육안 확인.
- PR: `izagood/synapse` main 대상, Conventional Commits.
