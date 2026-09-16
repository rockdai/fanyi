import { describe, expect, it } from "vitest";
import { isSiteExcluded, mergeSettings, normalizeDomain } from "../src/settings";

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
