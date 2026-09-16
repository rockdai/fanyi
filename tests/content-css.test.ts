import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/content.css", import.meta.url), "utf8");
const baseRule = css.match(/\.fanyi-translation\s*\{([^}]*)\}/)?.[1] ?? "";

describe("translation stylesheet", () => {
  it("leaves typography and color to be inherited from the source element", () => {
    expect(baseRule).toContain("font-size");
    for (const property of ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"]) {
      expect(baseRule).not.toMatch(new RegExp(`(^|[\\s;])${property}\\s*:`));
    }
  });
});
