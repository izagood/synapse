import { useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type FieldValue,
  type FrontmatterField,
} from "./frontmatterModel";

// frontmatter 속성 패널 (FR-2.9): 에디터 상단의 접이식 키/값 편집 UI.
//
// 파일을 직접 쓰지 않는다. raw frontmatter 문자열을 받아 모델로 파싱하고,
// 편집이 생기면 serializeFrontmatter로 다시 raw 문자열을 만들어 onChange로
// 돌려준다. MarkdownEditor가 이를 본문과 합쳐 기존 저장 경로로 기록한다.
//
// 라운드트립 안전: 편집하지 않은 항목(특히 synapse_id, 모델로 표현 못 하는
// 복잡한 YAML)은 원문 라인이 그대로 보존된다 — serializeFrontmatter가
// updated/removed/added 외의 항목을 건드리지 않기 때문.

interface Props {
  /** 구분선 포함 frontmatter 원문 (없으면 null) */
  frontmatter: string | null;
  /** 편집 결과 raw frontmatter 문자열을 돌려준다 */
  onChange(next: string): void;
}

export function FrontmatterPanel({ frontmatter, onChange }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // 모델은 "마운트 시점의 원문" 한 번만 파싱한다 — 원문 보존의 기준점.
  // 우리 자신의 편집으로 frontmatter prop이 바뀌어도 다시 파싱하면 추가/삭제
  // 항목이 기존 항목으로 섞여 중복되므로, 외부 변경(탭 전환·원격 머지) 시에는
  // 부모가 key로 이 컴포넌트를 리마운트해 새 기준으로 다시 파싱하게 한다.
  const initialRaw = useRef(frontmatter);
  const model = useMemo(() => parseFrontmatter(initialRaw.current), []);

  // 편집 상태: 키별 변경값 / 삭제 / 추가. 원문 보존을 위해 "변경분"만 추적한다.
  const [updated, setUpdated] = useState<Record<string, FieldValue>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<{ id: number; key: string; value: FieldValue }[]>([]);
  const [nextId, setNextId] = useState(1);

  if (!model) return null; // frontmatter 없음 → 패널 자체를 띄우지 않음

  function commit(
    nextUpdated: Record<string, FieldValue>,
    nextRemoved: Set<string>,
    nextAdded: { id: number; key: string; value: FieldValue }[],
  ) {
    setUpdated(nextUpdated);
    setRemoved(nextRemoved);
    setAdded(nextAdded);
    const out = serializeFrontmatter(model!, {
      updated: nextUpdated,
      removed: nextRemoved,
      added: nextAdded
        .filter((a) => a.key.trim() !== "")
        .map((a) => ({ key: a.key.trim(), value: a.value })),
    });
    onChange(out);
  }

  // 현재 화면에 보여줄 기존 필드(삭제분 제외) — value는 updated가 있으면 그걸 우선
  const existing = model.fields.filter((f) => !removed.has(f.key));

  function currentValue(field: FrontmatterField): FieldValue {
    return Object.prototype.hasOwnProperty.call(updated, field.key)
      ? updated[field.key]
      : field.value;
  }

  function setFieldValue(key: string, value: FieldValue) {
    commit({ ...updated, [key]: value }, removed, added);
  }

  function removeField(key: string) {
    const nextRemoved = new Set(removed);
    nextRemoved.add(key);
    const nextUpdated = { ...updated };
    delete nextUpdated[key];
    commit(nextUpdated, nextRemoved, added);
  }

  function addField() {
    const next = [...added, { id: nextId, key: "", value: { kind: "scalar", value: "" } as FieldValue }];
    setNextId(nextId + 1);
    commit(updated, removed, next);
  }

  function updateAdded(id: number, patch: Partial<{ key: string; value: FieldValue }>) {
    commit(
      updated,
      removed,
      added.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  }

  function removeAdded(id: number) {
    commit(
      updated,
      removed,
      added.filter((a) => a.id !== id),
    );
  }

  const hasRows = existing.length > 0 || added.length > 0;

  return (
    <div className="frontmatter-panel">
      <button
        type="button"
        className="frontmatter-panel-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? t("editor.propertiesHide") : t("editor.propertiesShow")}
      >
        <span className={`fm-caret ${open ? "open" : ""}`}>▸</span>
        {t("editor.properties")}
        {!open && hasRows && <span className="fm-count">{existing.length + added.length}</span>}
      </button>

      {open && (
        <div className="frontmatter-panel-body">
          {!hasRows && <div className="fm-empty">{t("editor.emptyProperties")}</div>}

          {existing.map((field) => (
            <FieldRow
              key={field.key}
              fieldKey={field.key}
              value={currentValue(field)}
              editable={field.editable}
              onChange={(v) => setFieldValue(field.key, v)}
              onRemove={() => removeField(field.key)}
            />
          ))}

          {added.map((row) => (
            <FieldRow
              key={`new-${row.id}`}
              fieldKey={row.key}
              value={row.value}
              editable
              keyEditable
              onKeyChange={(k) => updateAdded(row.id, { key: k })}
              onChange={(v) => updateAdded(row.id, { value: v })}
              onRemove={() => removeAdded(row.id)}
            />
          ))}

          <button type="button" className="fm-add" onClick={addField}>
            + {t("editor.addProperty")}
          </button>
        </div>
      )}
    </div>
  );
}

interface FieldRowProps {
  fieldKey: string;
  value: FieldValue;
  editable: boolean;
  keyEditable?: boolean;
  onKeyChange?(key: string): void;
  onChange(value: FieldValue): void;
  onRemove(): void;
}

function FieldRow({
  fieldKey,
  value,
  editable,
  keyEditable,
  onKeyChange,
  onChange,
  onRemove,
}: FieldRowProps) {
  const t = useT();

  return (
    <div className={`fm-row ${editable ? "" : "fm-row-readonly"}`}>
      {keyEditable ? (
        <input
          className="fm-key-input"
          value={fieldKey}
          placeholder={t("editor.propertyKeyPlaceholder")}
          onChange={(e) => onKeyChange?.(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <span className="fm-key">{fieldKey}</span>
      )}

      <div className="fm-value">
        {value.kind === "list" ? (
          <TagEditor
            tags={value.value}
            disabled={!editable}
            onChange={(tags) => onChange({ kind: "list", value: tags })}
          />
        ) : (
          <ScalarEditor
            value={value.value}
            disabled={!editable}
            onChange={(v) => onChange({ kind: "scalar", value: v })}
          />
        )}
      </div>

      <button
        type="button"
        className="fm-remove"
        onClick={onRemove}
        title={t("editor.removeProperty")}
        disabled={!editable && !keyEditable}
      >
        ×
      </button>
    </div>
  );
}

function ScalarEditor({
  value,
  disabled,
  onChange,
}: {
  value: string | number | boolean;
  disabled: boolean;
  onChange(value: string | number | boolean): void;
}) {
  const t = useT();
  if (typeof value === "boolean") {
    return (
      <input
        type="checkbox"
        className="fm-bool"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  return (
    <input
      className="fm-scalar-input"
      value={String(value)}
      disabled={disabled}
      placeholder={t("editor.propertyValuePlaceholder")}
      title={disabled ? t("editor.propertyReadonly") : undefined}
      onChange={(e) => {
        // 숫자였던 값은 유효 숫자일 때만 숫자 유지, 아니면 문자열로 전환
        if (typeof value === "number" && /^-?\d*\.?\d+$/.test(e.target.value.trim())) {
          onChange(Number(e.target.value.trim()));
        } else {
          onChange(e.target.value);
        }
      }}
      spellCheck={false}
    />
  );
}

function TagEditor({
  tags,
  disabled,
  onChange,
}: {
  tags: string[];
  disabled: boolean;
  onChange(tags: string[]): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (!tags.includes(v)) onChange([...tags, v]);
    setDraft("");
  }

  return (
    <div className="fm-tags">
      {tags.map((tag, i) => (
        <span className="fm-tag" key={`${tag}-${i}`}>
          {tag}
          {!disabled && (
            <button
              type="button"
              className="fm-tag-remove"
              title={t("editor.removeTag")}
              onClick={() => onChange(tags.filter((_, j) => j !== i))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          className="fm-tag-input"
          value={draft}
          placeholder={t("editor.tagPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={add}
          spellCheck={false}
        />
      )}
    </div>
  );
}
