import { useSettings } from "../stores/settings";
import { en } from "./locales/en";
import { ko } from "./locales/ko";

export type Locale = "ko" | "en";

export const SUPPORTED_LOCALES: { code: Locale; label: string }[] = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
];

const locales = { ko, en } as const;

type LeafPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = LeafPaths<typeof ko>;
export type TranslationParams = Record<string, string | number>;

export function normalizeLocale(language: string | null | undefined): Locale {
  return language === "en" ? "en" : "ko";
}

function readPath(locale: Locale, key: TranslationKey): string | undefined {
  let value: unknown = locales[locale];
  for (const segment of key.split(".")) {
    if (!value || typeof value !== "object" || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : undefined;
}

export function translate(
  language: string | null | undefined,
  key: TranslationKey,
  params: TranslationParams = {},
): string {
  const locale = normalizeLocale(language);
  const template = readPath(locale, key) ?? readPath("ko", key) ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}

export function useT() {
  const language = useSettings((s) => s.settings.appearance.language);
  return (key: TranslationKey, params?: TranslationParams) =>
    translate(language, key, params);
}

export function flattenKeys(
  value: object,
  prefix = "",
  keys: string[] = [],
): string[] {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") keys.push(path);
    else if (child && typeof child === "object") {
      flattenKeys(child, path, keys);
    }
  }
  return keys;
}

export const localeDictionaries = locales;
