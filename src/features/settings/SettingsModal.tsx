import { useEffect, useState } from "react";
import { useSettings } from "../../stores/settings";
import { useUpdate } from "../../stores/update";
import { SUPPORTED_LOCALES, useT } from "../../i18n";
import type { Language } from "../../ipc/types";

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
  const t = useT();

  return (
    <section>
      <h3>{t("update.section")}</h3>
      <div className="setting-row">
        <span>{t("update.currentVersion", { version: current ? `v${current}` : "" })}</span>
        {available ? (
          <button
            className="primary-btn update-install-btn"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing
              ? t("update.installing")
              : t("update.installVersion", { version: available })}
          </button>
        ) : (
          <button
            className="setting-action-btn"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? t("update.checking") : t("update.check")}
          </button>
        )}
      </div>
      {checked && !available && !checking && !error && (
        <p className="setting-hint">{t("update.upToDate")}</p>
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
  const t = useT();

  if (!show) return null;

  return (
    <div className="modal-backdrop" onClick={closeSettings}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("settings.title")}</h2>

        <section>
          <h3>{t("settings.appearance")}</h3>
          <label className="setting-row">
            <span>{t("settings.theme")}</span>
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
              <option value="system">{t("settings.themeSystem")}</option>
              <option value="light">{t("settings.themeLight")}</option>
              <option value="dark">{t("settings.themeDark")}</option>
            </select>
          </label>
          <label className="setting-row">
            <span>{t("settings.language")}</span>
            <select
              value={settings.appearance.language}
              onChange={(e) =>
                void update({
                  appearance: {
                    ...settings.appearance,
                    language: e.target.value as Language,
                  },
                })
              }
            >
              {SUPPORTED_LOCALES.map((locale) => (
                <option key={locale.code} value={locale.code}>
                  {locale.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section>
          <h3>{t("settings.editor")}</h3>
          <label className="setting-row">
            <span>{t("settings.font")}</span>
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
            <option value="system-ui" label={t("settings.systemDefault")} />
            <option value="Pretendard" />
            <option value="Noto Sans KR" />
            <option value="Apple SD Gothic Neo" />
            <option value="D2Coding" />
            <option value="JetBrains Mono" />
            <option value="monospace" />
          </datalist>
          <label className="setting-row">
            <span>{t("settings.fontSize")}</span>
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
            <span>{t("settings.autoSaveDelay")}</span>
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
          <h3>{t("settings.files")}</h3>
          <label className="setting-row">
            <span>{t("settings.confirmDelete")}</span>
            <input
              type="checkbox"
              checked={settings.files.confirmDelete}
              onChange={(e) =>
                void update({ files: { confirmDelete: e.target.checked } })
              }
            />
          </label>
          {!settings.files.confirmDelete && (
            <p className="setting-hint">
              {t("settings.deleteWarning")}
            </p>
          )}
        </section>

        <section>
          <h3>{t("settings.sync")}</h3>
          <label className="setting-row">
            <span>{t("settings.autoSync")}</span>
            <input
              type="checkbox"
              checked={settings.sync.auto}
              onChange={(e) =>
                void update({ sync: { ...settings.sync, auto: e.target.checked } })
              }
            />
          </label>
          <label className="setting-row">
            <span>{t("settings.syncInterval")}</span>
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
          <h3>{t("settings.htmlViewer")}</h3>
          <label className="setting-row">
            <span>{t("settings.allowNetwork")}</span>
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
            <span>{t("settings.allowScripts")}</span>
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
              {t("settings.scriptWarning")}
            </p>
          )}
        </section>

        <UpdateSection />

        <div className="modal-actions">
          <button className="primary-btn" onClick={closeSettings}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
