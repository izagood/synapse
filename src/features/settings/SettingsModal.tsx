import { useEffect, useRef, useState } from "react";
import { useSettings } from "../../stores/settings";
import { useUpdate } from "../../stores/update";
import { ipc } from "../../ipc/ipc";
import { SUPPORTED_LOCALES, useT } from "../../i18n";
import { CUSTOM_COLOR_KEYS } from "../../ipc/types";
import type { ConfigSyncStatus, CustomColorKey, Language, ThemeSetting } from "../../ipc/types";
import { PRESET_PALETTES, effectiveBaseTheme } from "../theme/theme";

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

// 설정 동기화 (1-E): 개인 config 레포를 연결해 settings.json을 기기 간 공유
function ConfigSyncSection() {
  const t = useT();
  const reloadSettings = useSettings((s) => s.init);
  const [status, setStatus] = useState<ConfigSyncStatus | null>(null);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkedRef = useRef(false);

  useEffect(() => {
    ipc.configSyncStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    linkedRef.current = status?.linked ?? false;
  }, [status]);

  // 설정 화면을 닫을 때(=언마운트) 연결돼 있으면 누적된 로컬 커밋을 push/pull
  useEffect(() => {
    return () => {
      if (linkedRef.current) void ipc.configSyncNow().catch(() => {});
    };
  }, []);

  const run = async (fn: () => Promise<ConfigSyncStatus>, reload = false) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setStatus(next);
      if (reload) await reloadSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t("configSync.section")}</h3>
      {status?.linked ? (
        <>
          <div className="setting-row">
            <span>{t("configSync.linkedTo", { repo: status.repoName ?? "" })}</span>
            <span className="setting-actions">
              <button
                className="setting-action-btn"
                disabled={busy}
                onClick={() => void run(() => ipc.configSyncNow())}
              >
                {t("configSync.syncNow")}
              </button>
              <button
                className="setting-action-btn"
                disabled={busy}
                onClick={() => void run(() => ipc.unlinkConfigRepo(true), true)}
              >
                {t("configSync.unlink")}
              </button>
            </span>
          </div>
          <p className="setting-hint">{t("configSync.linkedHint")}</p>
        </>
      ) : (
        <>
          <p className="setting-hint">{t("configSync.intro")}</p>
          <label className="setting-row">
            <span>{t("configSync.repoLabel")}</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/synapse-config"
              spellCheck={false}
            />
          </label>
          <div className="modal-actions">
            <button
              className="setting-action-btn"
              disabled={busy || !repo.trim()}
              onClick={() => void run(() => ipc.linkConfigRepo(repo.trim(), false), true)}
            >
              {t("configSync.link")}
            </button>
            <button
              className="primary-btn"
              disabled={busy || !repo.trim()}
              onClick={() => void run(() => ipc.linkConfigRepo(repo.trim(), true), true)}
            >
              {t("configSync.create")}
            </button>
          </div>
        </>
      )}
      {error && <p className="setting-warning error">{error}</p>}
    </section>
  );
}

// 선택 가능한 모델 목록(빈 값=CLI 기본). datalist로 제안하되 자유 입력도 허용한다.
const AGENT_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

// Claude 에이전트 설정 (2-D): 인증 방식·모델·API 키. 키는 키체인에만 저장된다.
function AgentSection() {
  const t = useT();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc.hasAgentApiKey().then(setHasKey).catch(() => setHasKey(false));
  }, []);

  const saveKey = async () => {
    if (!keyInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.setAgentApiKey(keyInput.trim());
      setKeyInput("");
      setHasKey(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.clearAgentApiKey();
      setHasKey(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apiKeyMode = settings.agent.authMode === "apiKey";

  return (
    <section>
      <h3>{t("settings.agent")}</h3>
      <label className="setting-row">
        <span>{t("settings.agentAuthMode")}</span>
        <select
          value={settings.agent.authMode}
          onChange={(e) =>
            void update({
              agent: {
                ...settings.agent,
                authMode: e.target.value as "subscription" | "apiKey",
              },
            })
          }
        >
          <option value="subscription">{t("settings.agentAuthSubscription")}</option>
          <option value="apiKey">{t("settings.agentAuthApiKey")}</option>
        </select>
      </label>
      <p className="setting-hint">{t("settings.agentAuthHint")}</p>

      {apiKeyMode && (
        <>
          <label className="setting-row">
            <span>
              {t("settings.agentApiKey")} ·{" "}
              {hasKey ? t("settings.agentApiKeySet") : t("settings.agentApiKeyNotSet")}
            </span>
            <span className="setting-actions">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={t("settings.agentApiKeyPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="setting-action-btn"
                disabled={busy || !keyInput.trim()}
                onClick={() => void saveKey()}
              >
                {t("settings.agentApiKeySave")}
              </button>
              {hasKey && (
                <button
                  className="setting-action-btn"
                  disabled={busy}
                  onClick={() => void clearKey()}
                >
                  {t("settings.agentApiKeyClear")}
                </button>
              )}
            </span>
          </label>
          <p className="setting-hint">{t("settings.agentApiKeyStored")}</p>
          {!hasKey && (
            <p className="setting-warning error">{t("settings.agentApiKeyMissing")}</p>
          )}
          {error && <p className="setting-warning error">{error}</p>}
        </>
      )}

      <label className="setting-row">
        <span>{t("settings.agentModel")}</span>
        <input
          list="synapse-agent-models"
          value={settings.agent.model}
          onChange={(e) =>
            void update({ agent: { ...settings.agent, model: e.target.value } })
          }
          placeholder={t("settings.agentModelDefault")}
          spellCheck={false}
        />
      </label>
      <datalist id="synapse-agent-models">
        {AGENT_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </section>
  );
}

// 단일 전역 설정 화면 (FR-5.2) — 모든 항목이 이 한 곳에서 관리된다
// 커스텀 색상 편집기 — 활성 테마 위에 개별 색을 덮어쓴다.
// 컬러 피커 초기값은 선택한 테마의 기본 팔레트에서 가져온다.
function ThemeColorEditor() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const t = useT();

  const { theme, customColors } = settings.appearance;
  const preset = PRESET_PALETTES[effectiveBaseTheme(theme)];
  const hasOverrides = Object.keys(customColors).length > 0;

  const setColor = (key: CustomColorKey, value: string) =>
    void update({
      appearance: {
        ...settings.appearance,
        customColors: { ...customColors, [key]: value },
      },
    });

  const reset = () =>
    void update({
      appearance: { ...settings.appearance, customColors: {} },
    });

  return (
    <>
      <div className="custom-colors-head">
        <span>{t("settings.customColors")}</span>
        <button className="custom-colors-reset" disabled={!hasOverrides} onClick={reset}>
          {t("settings.resetColors")}
        </button>
      </div>
      <p className="setting-hint">{t("settings.customColorsHint")}</p>
      <div className="color-grid">
        {CUSTOM_COLOR_KEYS.map((key) => (
          <label
            key={key}
            className={customColors[key] != null ? "color-row overridden" : "color-row"}
          >
            <input
              type="color"
              value={customColors[key] ?? preset[key]}
              onChange={(e) => setColor(key, e.target.value)}
            />
            <span>{t(`settings.color.${key}`)}</span>
          </label>
        ))}
      </div>
    </>
  );
}

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
                    theme: e.target.value as ThemeSetting,
                  },
                })
              }
            >
              <option value="system">{t("settings.themeSystem")}</option>
              <option value="light">{t("settings.themeLight")}</option>
              <option value="dark">{t("settings.themeDark")}</option>
              <option value="pink">{t("settings.themePink")}</option>
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
          <ThemeColorEditor />
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

        <AgentSection />

        <ConfigSyncSection />

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
