import { describe, expect, it } from "vitest";
import { isSameLanguage, isSiteExcluded, mergeSettings, normalizeDomain } from "../src/settings";

describe("site exclusion", () => {
  it("normalizes URL-like input", () => {
    expect(normalizeDomain("https://*.Example.com/path")).toBe("example.com");
  });

  it("matches a domain and its subdomains", () => {
    expect(isSiteExcluded("news.example.com", ["example.com"])).toBe(true);
    expect(isSiteExcluded("notexample.com", ["example.com"])).toBe(false);
  });
});

describe("selection languages", () => {
  it("follow the legacy language pair until they are set explicitly", () => {
    expect(mergeSettings({ sourceLanguage: "de", targetLanguage: "en" })).toMatchObject({ selectionSourceLanguage: "de", selectionTargetLanguage: "en" });
    expect(mergeSettings({ sourceLanguage: "de", targetLanguage: "en", selectionTargetLanguage: "ja" })).toMatchObject({ selectionSourceLanguage: "de", selectionTargetLanguage: "ja" });
    expect(mergeSettings({})).toMatchObject({ selectionSourceLanguage: "auto", selectionTargetLanguage: "zh-CN" });
  });
});

describe("page translation switch", () => {
  it("stays off unless it was turned on, whatever the translate-to-bottom option says", () => {
    expect(mergeSettings({})).toMatchObject({ pageTranslationEnabled: false });
    expect(mergeSettings({ translateFullPage: true })).toMatchObject({ pageTranslationEnabled: false });
    expect(mergeSettings({ pageTranslationEnabled: true })).toMatchObject({ pageTranslationEnabled: true });
  });
});

describe("language comparison", () => {
  it("matches on the primary language but keeps simplified and traditional Chinese apart", () => {
    expect(isSameLanguage("en-US", "en")).toBe(true);
    expect(isSameLanguage("zh", "zh-CN")).toBe(true);
    expect(isSameLanguage("zh-Hant", "zh-TW")).toBe(true);
    expect(isSameLanguage("zh-CN", "zh-TW")).toBe(false);
    expect(isSameLanguage("", "en")).toBe(false);
  });
});
