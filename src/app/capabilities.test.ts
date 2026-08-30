import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tauri v2 ACL 회귀 방지.
 *
 * 프론트가 부르는 window 명령이 capability에 없으면 IPC가 조용히 거부된다.
 * webview 콘솔에만 찍히므로 릴리스 빌드에서는 완전히 보이지 않고, 창이 안
 * 닫히거나(destroy 거부) 드래그가 안 되는(start_dragging 거부) 형태로만
 * 드러난다. 그래서 "소스에서 쓰는 명령"과 "capability가 허용하는 명령"을
 * 여기서 맞물려 검사한다.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Manifest = Record<
  string,
  {
    default_permission?: { permissions?: string[] } | null;
    permissions?: Record<string, { commands?: { allow?: string[] } }>;
    permission_sets?: Record<string, { permissions?: string[] }>;
  }
>;

const manifest: Manifest = JSON.parse(
  readFileSync(path.join(ROOT, "src-tauri/gen/schemas/acl-manifests.json"), "utf8"),
);

/** "core:window:allow-destroy" → ["core:window", "allow-destroy"] (가장 긴 플러그인 이름 우선) */
function splitIdentifier(id: string): [string, string] | undefined {
  let best: [string, string] | undefined;
  for (const plugin of Object.keys(manifest)) {
    if (!id.startsWith(`${plugin}:`)) continue;
    if (best && best[0].length >= plugin.length) continue;
    best = [plugin, id.slice(plugin.length + 1)];
  }
  return best;
}

/** capability 항목 하나가 실제로 여는 명령들을 "<플러그인>|<명령>"으로 펼친다 */
function expand(id: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(id)) return out;
  seen.add(id);

  const split = splitIdentifier(id);
  if (!split) return out;
  const [plugin, name] = split;
  const entry = manifest[plugin];

  const nested = (children: string[]) => {
    for (const child of children) {
      // 하위 항목은 정규화된 이름("core:path:default")일 수도, 같은 플러그인
      // 안의 짧은 이름("allow-destroy")일 수도 있다.
      const resolved = splitIdentifier(child) ? child : `${plugin}:${child}`;
      for (const cmd of expand(resolved, seen)) out.add(cmd);
    }
  };

  if (name === "default") {
    nested(entry.default_permission?.permissions ?? []);
    return out;
  }
  const set = entry.permission_sets?.[name];
  if (set) {
    nested(set.permissions ?? []);
    return out;
  }
  for (const cmd of entry.permissions?.[name]?.commands?.allow ?? []) {
    out.add(`${plugin}|${cmd}`);
  }
  return out;
}

function allowedCommands(): Set<string> {
  const capability = JSON.parse(
    readFileSync(path.join(ROOT, "src-tauri/capabilities/default.json"), "utf8"),
  ) as { permissions: string[] };
  const out = new Set<string>();
  for (const id of capability.permissions) {
    for (const cmd of expand(id)) out.add(cmd);
  }
  return out;
}

function frontendSources(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        chunks.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return chunks.join("\n");
}

/** 소스에 이 표시가 있으면 그 명령 권한이 반드시 있어야 한다 */
const RULES = [
  {
    marker: "onCloseRequested",
    command: "core:window|destroy",
    why: "close-requested JS 리스너가 있으면 Tauri가 OS 닫기를 취소하고(manager/window.rs) 창을 닫는 책임이 JS의 destroy()로 넘어온다",
  },
  {
    marker: "data-tauri-drag-region",
    command: "core:window|start_dragging",
    why: "드래그 영역은 네이티브가 아니라 주입 스크립트가 start_dragging IPC를 부르는 방식이다",
  },
  {
    marker: "getCurrentWindow().setTheme",
    command: "core:window|set_theme",
    why: "다크 모드에서 네이티브 타이틀바 색을 맞춘다",
  },
  {
    marker: "getCurrentWindow().setTitle",
    command: "core:window|set_title",
    why: "타이틀바에 열린 폴더명을 표시한다",
  },
] as const;

describe("tauri capability(default.json)", () => {
  const allowed = allowedCommands();
  const sources = frontendSources();

  it("core:default 확장이 동작한다(권한 해석 자체의 sanity)", () => {
    expect(allowed.has("core:window|set_theme")).toBe(true);
    expect(allowed.has("core:event|listen")).toBe(true);
  });

  for (const rule of RULES) {
    it(`${rule.marker} 를 쓰므로 ${rule.command} 권한이 있다`, () => {
      expect(
        sources.includes(rule.marker),
        `이 검사는 소스에 "${rule.marker}"가 있다는 전제로 존재한다. 사용을 그만뒀다면 규칙도 지운다.`,
      ).toBe(true);
      expect(allowed.has(rule.command), `${rule.command} 권한 누락 — ${rule.why}`).toBe(true);
    });
  }
});
