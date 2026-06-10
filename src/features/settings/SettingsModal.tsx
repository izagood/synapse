import { useSettings } from "../../stores/settings";

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
            <span>글자 크기</span>
            <input
              type="number"
              min={12}
              max={28}
              value={settings.editor.fontSize}
              onChange={(e) =>
                void update({
                  editor: { ...settings.editor, fontSize: Number(e.target.value) || 16 },
                })
              }
            />
          </label>
          <label className="setting-row">
            <span>자동 저장 지연 (ms)</span>
            <input
              type="number"
              min={200}
              step={100}
              value={settings.editor.autoSaveDelayMs}
              onChange={(e) =>
                void update({
                  editor: {
                    ...settings.editor,
                    autoSaveDelayMs: Number(e.target.value) || 1000,
                  },
                })
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
            <input
              type="number"
              min={1}
              max={60}
              value={settings.sync.intervalMinutes}
              onChange={(e) =>
                void update({
                  sync: {
                    ...settings.sync,
                    intervalMinutes: Number(e.target.value) || 5,
                  },
                })
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
              신뢰할 수 없는 HTML의 스크립트가 실행될 수 있습니다.
            </p>
          )}
        </section>

        <div className="modal-actions">
          <button className="primary-btn" onClick={closeSettings}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
