import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/content.css", import.meta.url), "utf8");
const baseRule = css.match(/\.fanyi-translation\s*\{([^}]*)\}/)?.[1] ?? "";

describe("translation stylesheet", () => {
  it("pins inherited typography and color so host page rules cannot override them", () => {
    for (const property of ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"]) {
      expect(baseRule).toMatch(new RegExp(`(^|[\\s;])${property}\\s*:\\s*inherit\\s*!important`));
    }
    expect(baseRule).toMatch(/font-size:\s*calc\(1em \* var\(--fanyi-font-scale/);
  });
});
