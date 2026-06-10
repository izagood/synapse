import { useEffect, useState } from "react";
import { useSettings } from "../../stores/settings";
import { useUpdate } from "../../stores/update";

// 숫자 설정 입력: 지우는 동안 빈칸을 허용하고(즉시 기본값으로 되돌리지 않음),
// 유효한 숫자만 커밋하며 포커스를 벗어날 때 범위를 보정한다
function NumberInput({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) {
          onCommit(clamp(n));
        }
      }}
      onBlur={() => {
        const n = Number(text);
        if (text === "" || !Number.isFinite(n)) {
          setText(String(value)); // 빈 채로 떠나면 기존 값 복원
        } else {
          const committed = clamp(n);
          setText(String(committed));
          onCommit(committed);
        }
      }}
    />
  );
}

function UpdateSection() {
  const { current, available, checking, installing, checked, error, check, install } =
    useUpdate();

  return (
    <section>
      <h3>업데이트</h3>
      <div className="setting-row">
        <span>현재 버전 {current ? `v${current}` : ""}</span>
        {available ? (
          <button
            className="primary-btn update-install-btn"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? "설치 중…" : `v${available} 설치 후 재시작`}
          </button>
        ) : (
          <button
            className="setting-action-btn"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? "확인 중…" : "업데이트 확인"}
          </button>
        )}
      </div>
      {checked && !available && !checking && !error && (
        <p className="setting-hint">최신 버전입니다.</p>
      )}
      {error && <p className="setting-warning error">{error}</p>}
    </section>
  );
}

// 단일 전역 설정 화면 (FR-5.2) — 모든 항목이 이 한 곳에서 관리된다
export function SettingsModal() {
  const show = useSettings((s) => s.showSettings);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const closeSettings = useSettings((s) => s.closeSettings);

  if (!show) return null;

  return (
    <div className="modal-backdrop" onClick={closeSettings}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>설정</h2>

        <section>
          <h3>화면</h3>
          <label className="setting-row">
            <span>테마</span>
            <select
              value={settings.appearance.theme}
              onChange={(e) =>
                void update({
                  appearance: {
                    ...settings.appearance,
                    theme: e.target.value as "system" | "light" | "dark",
                  },
                })
              }
            >
              <option value="system">시스템 따름</option>
              <option value="light">라이트</option>
              <option value="dark">다크</option>
            </select>
          </label>
        </section>

        <section>
          <h3>에디터</h3>
          <label className="setting-row">
            <span>폰트</span>
            <input
              list="synapse-fonts"
              value={settings.editor.fontFamily}
              onChange={(e) =>
                void update({
                  editor: { ...settings.editor, fontFamily: e.target.value || "system-ui" },
                })
              }
              placeholder="system-ui"
            />
          </label>
          <datalist id="synapse-fonts">
            <option value="system-ui" label="시스템 기본" />
            <option value="Pretendard" />
            <option value="Noto Sans KR" />
            <option value="Apple SD Gothic Neo" />
            <option value="D2Coding" />
            <option value="JetBrains Mono" />
            <option value="monospace" />
          </datalist>
          <label className="setting-row">
            <span>글자 크기</span>
            <NumberInput
              min={12}
              max={28}
              value={settings.editor.fontSize}
              onCommit={(fontSize) =>
                void update({ editor: { ...settings.editor, fontSize } })
              }
            />
          </label>
          <label className="setting-row">
            <span>자동 저장 지연 (ms)</span>
            <NumberInput
              min={200}
              max={10000}
              step={100}
              value={settings.editor.autoSaveDelayMs}
              onCommit={(autoSaveDelayMs) =>
                void update({ editor: { ...settings.editor, autoSaveDelayMs } })
              }
            />
          </label>
        </section>

        <section>
          <h3>동기화</h3>
          <label className="setting-row">
            <span>자동 동기화</span>
            <input
              type="checkbox"
              checked={settings.sync.auto}
              onChange={(e) =>
                void update({ sync: { ...settings.sync, auto: e.target.checked } })
              }
            />
          </label>
          <label className="setting-row">
            <span>동기화 주기 (분)</span>
            <NumberInput
              min={1}
              max={60}
              value={settings.sync.intervalMinutes}
              onCommit={(intervalMinutes) =>
                void update({ sync: { ...settings.sync, intervalMinutes } })
              }
            />
          </label>
        </section>

        <section>
          <h3>HTML 뷰어</h3>
          <label className="setting-row">
            <span>외부 이미지/리소스 허용</span>
            <input
              type="checkbox"
              checked={settings.htmlViewer.allowNetwork}
              onChange={(e) =>
                void update({
                  htmlViewer: { ...settings.htmlViewer, allowNetwork: e.target.checked },
                })
              }
            />
          </label>
          <label className="setting-row">
            <span>스크립트 실행 허용 (위험)</span>
            <input
              type="checkbox"
              checked={settings.htmlViewer.allowScripts}
              onChange={(e) =>
                void update({
                  htmlViewer: { ...settings.htmlViewer, allowScripts: e.target.checked },
                })
              }
            />
          </label>
          {settings.htmlViewer.allowScripts && (
            <p className="setting-warning error">
              스크립트 허용 시 HTML 정화 없이 원문 그대로 격리된 샌드박스에서
              실행됩니다. 신뢰할 수 있는 문서만 여세요.
            </p>
          )}
        </section>

        <UpdateSection />

        <div className="modal-actions">
          <button className="primary-btn" onClick={closeSettings}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
