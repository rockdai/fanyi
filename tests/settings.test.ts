import { describe, expect, it } from "vitest";
import { isSiteExcluded, normalizeDomain } from "../src/settings";

describe("site exclusion", () => {
  it("normalizes URL-like input", () => {
    expect(normalizeDomain("https://*.Example.com/path")).toBe("example.com");
  });

  it("matches a domain and its subdomains", () => {
    expect(isSiteExcluded("news.example.com", ["example.com"])).toBe(true);
    expect(isSiteExcluded("notexample.com", ["example.com"])).toBe(false);
  });
});
