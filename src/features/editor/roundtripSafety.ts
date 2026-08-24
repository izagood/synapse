import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token";

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: false,
});

type Signature = {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  attrs: [string, string][];
  children: Signature[];
};

const CONTENT_TYPES = new Set([
  "code_block",
  "code_inline",
  "fence",
  "html_block",
  "html_inline",
  "text",
]);

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeText(value: string): string {
  return normalizeLineEndings(value).replace(/\s+/g, " ").trim();
}

function normalizeCode(value: string): string {
  return normalizeLineEndings(value).replace(/\n+$/g, "");
}

function normalizeHtml(value: string): string {
  return normalizeText(value.replace(/>\s+/g, ">").replace(/\s+</g, "<"));
}

function normalizeUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

// markdown-it의 attrs 타입 선언은 [string, string][] 이지만 런타임 값은 다르다 —
// ordered_list_open의 start(1이 아닌 숫자로 시작하는 목록)는 number로 들어온다.
// 문자열로 가정하고 정규화하면 TypeError가 나면서 이 함수를 부르는 저장 경로
// (onUpdate → preserveFormatting → blockSignatures)가 통째로 죽으므로,
// 경계에서 문자열로 강제한다.
function normalizeAttr(name: string, value: unknown): [string, string] {
  const text = typeof value === "string" ? value : String(value);
  if (name === "href" || name === "src") return [name, normalizeUrl(text)];
  return [name, normalizeText(text)];
}

function normalizedContent(token: Token): string {
  if (token.type === "fence") {
    const info = normalizeText(token.info);
    const content = normalizeCode(token.content);
    return info ? `${info}\n${content}` : content;
  }
  if (token.type === "code_block" || token.type === "code_inline") {
    return normalizeCode(token.content);
  }
  if (token.type === "html_block" || token.type === "html_inline") {
    return normalizeHtml(token.content);
  }
  if (CONTENT_TYPES.has(token.type)) {
    return normalizeText(token.content);
  }
  return "";
}

function tokenSignature(token: Token): Signature | null {
  // 줄바꿈 토큰(soft/hard)은 시그니처에서 제외한다. breaks:true 전환으로
  // 에디터는 모든 문단 내 개행을 동일하게 렌더링·직렬화(\n)하므로,
  // 백슬래시·2칸 hard break가 개행으로 정규화되는 것은 손실이 아니라
  // 표기 정규화다 — 미편집 블록의 원본 바이트는 preserveFormatting이 지킨다.
  // (이걸 손실로 치면 hard break가 든 모든 기존 문서가 읽기 전용으로 잠긴다.)
  if (token.hidden || token.type === "softbreak" || token.type === "hardbreak") return null;

  return {
    type: token.type,
    tag: token.tag,
    nesting: token.nesting,
    content: normalizedContent(token),
    attrs: (token.attrs ?? []).map(([name, value]) => normalizeAttr(name, value)).sort(),
    children: (token.children ?? [])
      .map(tokenSignature)
      .filter((child): child is Signature => child !== null),
  };
}

/** top-level 블록 하나의 의미 시그니처와 원본에서의 소스 라인 범위. */
export type BlockSignature = {
  /** 블록 토큰 서브트리의 정규화 시그니처(JSON). 의미가 같으면 문자열이 같다. */
  sig: string;
  /** 원본 본문에서의 시작 라인 (0-indexed). */
  startLine: number;
  /** 끝 라인 (exclusive). */
  endLine: number;
};

// markdown-it 토큰 스트림을 top-level 블록으로 그룹화한다.
// 컨테이너(nesting=1)는 같은 level의 close(nesting=-1)까지, 자기완결 토큰
// (nesting=0: fence/hr/html_block 등)은 그 하나가 한 블록이다.
export function blockSignatures(markdown: string): BlockSignature[] {
  const tokens = md.parse(normalizeLineEndings(markdown), {});
  const blocks: BlockSignature[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    if (tokens[i].nesting === 1) {
      i++;
      while (i < tokens.length && !(tokens[i].level === 0 && tokens[i].nesting === -1)) i++;
      i++; // 닫는 토큰 포함
    } else {
      i++; // 자기완결 토큰 또는 홀로 남은 close
    }
    const group = tokens.slice(start, i);
    const sigs = group
      .map(tokenSignature)
      .filter((s): s is Signature => s !== null);
    if (sigs.length === 0) continue;
    let startLine = Infinity;
    let endLine = -Infinity;
    for (const t of group) {
      if (t.map) {
        startLine = Math.min(startLine, t.map[0]);
        endLine = Math.max(endLine, t.map[1]);
      }
    }
    if (!Number.isFinite(startLine)) continue; // 위치 정보 없는 블록은 건너뛴다
    blocks.push({ sig: JSON.stringify(sigs), startLine, endLine });
  }
  return blocks;
}

// ── 아래 감지들은 파서 비교(blockSignatures)가 구조적으로 못 잡는 손상을
//    raw 원문 검사로 보완한다. 이 검사의 오탐은 "정상 문서 영구 읽기 전용"
//    이므로(2차 감사에서 오탐 4종 실측), 두 원칙을 지킨다:
//    ① 코드펜스·코드스팬 안은 바이트 그대로 보존되는 영역 — 먼저 가린다.
//    ② 패턴은 실제 손상이 일어나는 문맥(표, 정의 문법)으로 좁힌다.

/** 코드펜스(```/~~~, 문자·길이 매칭)와 인라인 코드스팬을 가린다.
 *  줄 구조는 유지해 라인 기반 검사(^ 앵커, 표 문맥)가 계속 동작한다. */
function maskCodeRegions(markdown: string): string {
  const lines = normalizeLineEndings(markdown).split("\n");
  let fence: { ch: string; len: number } | null = null;
  const out = lines.map((line) => {
    const t = line.trimStart();
    const m = t.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && t.slice(m[1].length).trim() === "") {
        fence = null;
      }
      return "";
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      return "";
    }
    return line.replace(/(`+)[^`\n]*?\1/g, (s) => " ".repeat(s.length));
  });
  return out.join("\n");
}

// reference 정의: 선행 공백 0~3칸(CommonMark). 목적지는 공백 없는 한 토큰
// (+선택적 따옴표 제목)일 때만 — `[10:30]: 회의 메모` 같은 여러 단어 목적지는
// 정의가 아니라 평문으로 안정 왕복하므로 제외한다(오탐 F3). `[^…]`는 각주.
const REF_DEF_REGEX =
  /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]+(\S+(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)[ \t]*$/;

function extractRefDefs(masked: string): Map<string, string> {
  const defs = new Map<string, string>();
  for (const line of masked.split("\n")) {
    const match = line.match(REF_DEF_REGEX);
    if (match) defs.set(match[1], match[2]);
  }
  return defs;
}

/** 표 문맥의 raw 별칭 위키링크(`| [[a|b]] |`) — 파서가 파이프에서 열을
 *  절단해 감지 양쪽이 똑같이 손상되는 구조적 맹점이라 사전 검사로만 잡는다.
 *  매치 지점 단위로 판정한다: 문서 다른 곳의 `\[\[` 리터럴이 검사를 끄지
 *  않고(미탐 M1), 이스케이프된 링크(`\[\[…\]\]`)와 표 밖 산문 파이프는
 *  걸리지 않는다. 표 문맥 = 인접한 구분행(`| --- |`)이 있는 행. */
function hasRawTableCellAliasWikilink(masked: string): boolean {
  const CELL = /\|[^\S\n]*(?<!\\)\[\[[^\]\n]*\|[^\]\n]*\]\]/;
  const DELIM = /^\s*\|?[\s:|]*-{3,}[\s:|-]*\|?\s*$/;
  const lines = masked.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!CELL.test(lines[i])) continue;
    // 헤더 행: 바로 아래가 구분행
    if (i + 1 < lines.length && DELIM.test(lines[i + 1])) return true;
    // 본문 행: 파이프로 시작하는 행을 거슬러 올라가면 구분행이 나온다
    for (let j = i - 1; j >= 0 && /^\s*\|/.test(lines[j]); j--) {
      if (DELIM.test(lines[j])) return true;
    }
  }
  return false;
}

// 각주: 원본에 각주 "정의"(`[^x]:` 줄)가 실제로 있을 때만 검사한다 —
// 정규식 문자클래스 언급(`[^abc]`)이나 정의 없는 참조는 평문으로 안정
// 왕복하므로 잠그지 않는다(오탐 F4). 참조는 이스케이프되지 않은 것만
// 센다 — 사용자가 이미 `\[^x\]`로 쓴 리터럴은 손상이 아니다(오탐 F1).
const FOOTNOTE_DEF_REGEX = /^ {0,3}\[\^[^\]]+\]:/m;
const FOOTNOTE_REF_REGEX = /(?<!\\)\[\^[^\]]+\]/;
const FOOTNOTE_ESCAPED_REGEX = /\\\[\^[^\]]+\\\]/;

export function hasRoundtripContentLoss(original: string, serialized: string): boolean {
  if (normalizeLineEndings(original) === normalizeLineEndings(serialized)) return false;
  const a = blockSignatures(original).map((b) => b.sig);
  const b = blockSignatures(serialized).map((b) => b.sig);
  if (JSON.stringify(a) !== JSON.stringify(b)) return true;

  const maskedOriginal = maskCodeRegions(original);
  const maskedSerialized = maskCodeRegions(serialized);

  const originalDefs = extractRefDefs(maskedOriginal);
  if (originalDefs.size > 0) {
    const serializedDefs = extractRefDefs(maskedSerialized);
    for (const [key, value] of originalDefs) {
      if (serializedDefs.get(key) !== value) return true;
    }
  }

  if (hasRawTableCellAliasWikilink(maskedOriginal)) return true;

  if (
    FOOTNOTE_DEF_REGEX.test(maskedOriginal) &&
    FOOTNOTE_REF_REGEX.test(maskedOriginal) &&
    FOOTNOTE_ESCAPED_REGEX.test(maskedSerialized)
  ) {
    return true;
  }

  return false;
}
