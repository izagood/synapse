import { describe, expect, it } from "vitest";
import {
  flattenKeys,
  localeDictionaries,
  normalizeLocale,
  translate,
} from "./index";

describe("i18n", () => {
  it("normalizes unsupported locales to Korean", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("fr")).toBe("ko");
    expect(normalizeLocale(null)).toBe("ko");
  });

  it("interpolates parameters", () => {
    expect(translate("en", "update.installVersion", { version: "1.2.3" })).toBe(
      "Install v1.2.3 and restart",
    );
  });

  it("falls back to Korean for unsupported locales", () => {
    expect(translate("fr", "start.openFolder")).toBe("폴더 열기");
  });

  it("keeps English keys in sync with Korean", () => {
    expect(flattenKeys(localeDictionaries.en)).toEqual(flattenKeys(localeDictionaries.ko));
  });
});
