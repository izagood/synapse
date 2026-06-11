// frontmatter 키/값 편집 모델 (FR-2.9 2단계)
//
// 의존성 없이 간단한 YAML 서브셋만 다룬다:
//   - 문자열 / 숫자 / 불리언 스칼라
//   - 문자열 배열(태그 등): `[a, b]` 인라인 또는 `- a` 블록
// 모델로 표현 못 하는 복잡한 YAML(중첩 맵, 멀티라인 등)은 raw로 보존하고
// 편집 불가(editable=false)로 표시한다.
//
// 핵심 제약 — 라운드트립 안전성:
//   parse → (편집 안 함) → serialize 는 원문(--- 구분선 포함)과 1:1로 같아야 한다.
//   편집하지 않은 항목은 원문 라인을 그대로 보존한다. 특히 synapse_id 같은
//   기존 키가 유실/변형되면 안 된다.

export type ScalarValue = string | number | boolean;

export type FieldValue =
  | { kind: "scalar"; value: ScalarValue }
  | { kind: "list"; value: string[] };

export interface FrontmatterField {
  key: string;
  value: FieldValue;
  /** false면 모델로 안전히 표현 못 함 → UI에서 편집 비활성, 원문 보존 */
  editable: boolean;
}

interface RawEntry {
  key: string;
  /** 이 항목의 원문(줄바꿈 미포함 라인 배열) */
  rawLines: string[];
  field: FieldValue | null; // null이면 모델 표현 불가
}

interface ParsedRaw {
  /** 줄바꿈 종류 ("\n" | "\r\n") */
  eol: string;
  /** "---" 시작/끝 라인 원문(줄바꿈 미포함) */
  openLine: string;
  closeLine: string;
  entries: RawEntry[];
}

export interface FrontmatterModel {
  fields: FrontmatterField[];
  /** 내부용: 원문 보존을 위한 파싱 상태. 직접 건드리지 말 것. */
  readonly _raw: ParsedRaw;
}

// ---------- 파싱 ----------

const FRONTMATTER_BLOCK_RE = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*)(?:\r?\n|$)/;

/**
 * frontmatter 원문(splitFrontmatter가 돌려준 `frontmatter` 문자열)을 모델로 파싱.
 * 입력은 `---\n...\n---` 형태(splitFrontmatter는 trailing을 trimEnd 함).
 * 파싱 불가하면 null (호출부는 편집 비활성).
 */
export function parseFrontmatter(raw: string | null): FrontmatterModel | null {
  if (raw == null) return null;
  const match = raw.match(FRONTMATTER_BLOCK_RE);
  if (!match) return null;

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const openLine = match[1].replace(/\r?\n$/, "");
  const closeLine = match[3].replace(/^\r?\n/, "");
  const inner = match[2];
  const lines = inner.length === 0 ? [] : inner.split(/\r?\n/);

  const entries: RawEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 빈 줄/주석은 독립 raw 항목으로 보존 (key 없음)
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      entries.push({ key: "", rawLines: [line], field: null });
      i++;
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (!keyMatch) {
      // 들여쓰기된 줄이나 모델 밖 구문 → 직전 항목에 흡수하거나 raw로
      if (entries.length > 0 && /^\s+/.test(line)) {
        const prev = entries[entries.length - 1];
        prev.rawLines.push(line);
        prev.field = null; // 멀티라인 → 모델 표현 불가
      } else {
        entries.push({ key: "", rawLines: [line], field: null });
      }
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2];
    const rawLines = [line];

    // 블록 리스트(`- item`)인지: 값이 비어 있고 다음 줄들이 `- `로 시작
    if (rest.trim() === "" && i + 1 < lines.length && isBlockListItem(lines[i + 1])) {
      const items: string[] = [];
      let j = i + 1;
      let parsable = true;
      while (j < lines.length && isBlockListItem(lines[j])) {
        rawLines.push(lines[j]);
        const itemRaw = lines[j].replace(/^\s*-\s?/, "");
        const parsed = parseScalar(itemRaw);
        if (parsed === undefined) parsable = false;
        else items.push(String(parsed));
        j++;
      }
      entries.push({
        key,
        rawLines,
        field: parsable ? { kind: "list", value: items } : null,
      });
      i = j;
      continue;
    }

    // 인라인: `key: value` — value를 스칼라/인라인배열로 해석
    const field = parseInlineValue(rest);
    entries.push({ key, rawLines, field });
    i++;
  }

  const _raw: ParsedRaw = { eol, openLine, closeLine, entries };
  const fields: FrontmatterField[] = entries
    .filter((e) => e.key !== "")
    .map((e) => ({
      key: e.key,
      value: e.field ?? { kind: "scalar", value: rawValueOf(e) },
      editable: e.field !== null,
    }));

  return { fields, _raw };
}

function isBlockListItem(line: string): boolean {
  return /^\s*-\s+\S/.test(line) || /^\s*-\s*$/.test(line);
}

function rawValueOf(entry: RawEntry): string {
  // 모델 표현 불가 항목의 표시용 값 (편집 비활성, 원문 보존)
  const first = entry.rawLines[0];
  const idx = first.indexOf(":");
  return idx >= 0 ? first.slice(idx + 1).trim() : first.trim();
}

function parseInlineValue(rest: string): FieldValue | null {
  const trimmed = rest.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const items = parseInlineList(trimmed);
    return items === null ? null : { kind: "list", value: items };
  }
  if (trimmed === "") return { kind: "scalar", value: "" };
  const scalar = parseScalar(trimmed);
  if (scalar === undefined) return null;
  return { kind: "scalar", value: scalar };
}

function parseInlineList(text: string): string[] | null {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = splitTopLevelCommas(inner);
  if (parts === null) return null;
  const items: string[] = [];
  for (const part of parts) {
    const scalar = parseScalar(part.trim());
    if (scalar === undefined) return null;
    items.push(String(scalar));
  }
  return items;
}

function splitTopLevelCommas(inner: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote || depth !== 0) return null; // 균형 안 맞음 → 거부
  parts.push(cur);
  return parts;
}

/** 큰따옴표 본문 해제. `\\`, `\"`만 인식하고 그 외 이스케이프는 거부(null). */
function unescapeDoubleQuoted(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === "\\" || next === '"') {
        out += next;
        i++;
        continue;
      }
      return null; // 미지원 이스케이프 → 모델 거부, 원문 보존
    }
    if (ch === '"') return null; // 이스케이프 안 된 따옴표 → 균형 깨짐
    out += ch;
  }
  return out;
}

/** 작은따옴표 본문 해제. `''`만 리터럴 `'`. 그 외 lone `'`는 거부(null). */
function unescapeSingleQuoted(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      if (body[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return null;
    }
    out += ch;
  }
  return out;
}

/**
 * 스칼라 파싱. 모델 가능하면 string/number/boolean, 불가하면 undefined.
 * 따옴표 문자열, true/false, 숫자, 그 외 평문 문자열을 지원.
 */
function parseScalar(text: string): ScalarValue | undefined {
  const t = text.trim();
  if (t === "") return "";
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const dq = unescapeDoubleQuoted(t.slice(1, -1));
    return dq === null ? undefined : dq;
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    const sq = unescapeSingleQuoted(t.slice(1, -1));
    return sq === null ? undefined : sq;
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  // 그 외엔 평문 문자열로 취급 (단, YAML 특수문자 시작/맵 구문은 거부해 안전 유지)
  if (/^[#&*!|>%@`]/.test(t)) return undefined;
  if (t.includes(": ")) return undefined; // 맵처럼 보이면 거부
  return t;
}

// ---------- 직렬화 ----------

/** 문자열을 안전하게 인용해야 하는지 */
function needsQuote(value: string): boolean {
  if (value === "") return true;
  if (value !== value.trim()) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(value)) return true;
  if (/^-?\d*\.?\d+$/.test(value)) return true;
  if (/^[#&*!|>%@`[\]{},"'-]/.test(value)) return true;
  if (/[:#"'\\]/.test(value)) return true;
  return false;
}

function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeScalar(value: ScalarValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return needsQuote(value) ? quoteString(value) : value;
}

function serializeInlineList(items: string[]): string {
  return `[${items.map((s) => serializeScalar(s)).join(", ")}]`;
}

function serializeField(key: string, value: FieldValue): string {
  if (value.kind === "list") {
    return `${key}: ${serializeInlineList(value.value)}`;
  }
  return `${key}: ${serializeScalar(value.value)}`;
}

/**
 * 모델 + 사용자가 변경한 필드(changes)를 받아 frontmatter 원문을 재구성.
 * - 변경되지 않은 항목은 원문 라인을 그대로 보존 (synapse_id 등 안전).
 * - 변경/추가된 항목만 재직렬화.
 */
export interface SerializeChanges {
  /** key→FieldValue 부분 맵. 여기 있는 키만 다시 쓴다. */
  updated?: Record<string, FieldValue>;
  /** 삭제할 키 집합. */
  removed?: ReadonlySet<string>;
  /** 새로 추가된 필드 (순서대로 끝에 append). */
  added?: { key: string; value: FieldValue }[];
}

export function serializeFrontmatter(
  model: FrontmatterModel,
  changes: SerializeChanges = {},
): string {
  const { eol, openLine, closeLine, entries } = model._raw;
  const updated = changes.updated ?? {};
  const removed = changes.removed ?? new Set<string>();
  const added = changes.added ?? [];

  const out: string[] = [openLine];

  for (const entry of entries) {
    if (entry.key !== "" && removed.has(entry.key)) continue;
    if (entry.key !== "" && Object.prototype.hasOwnProperty.call(updated, entry.key)) {
      out.push(serializeField(entry.key, updated[entry.key]));
    } else {
      // 변경 없음 → 원문 보존
      out.push(...entry.rawLines);
    }
  }

  for (const field of added) {
    if (removed.has(field.key)) continue;
    out.push(serializeField(field.key, field.value));
  }

  out.push(closeLine);
  return out.join(eol);
}

/**
 * 모델 전체를 처음부터 직렬화 (UI가 들고 있는 필드 배열 → frontmatter 원문).
 * 편집되지 않은 editable=false 항목까지 포함해 원문 보존을 보장하려면
 * serializeFrontmatter(model, changes)를 쓰는 게 낫다. 이 함수는
 * "전부 모델로 표현 가능한" 단순 문서를 새로 만들 때 쓴다.
 */
export function buildFrontmatter(
  fields: { key: string; value: FieldValue }[],
  eol = "\n",
): string {
  const lines = ["---", ...fields.map((f) => serializeField(f.key, f.value)), "---"];
  return lines.join(eol);
}
