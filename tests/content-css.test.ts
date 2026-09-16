import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/content.css", import.meta.url), "utf8");
const baseRule = css.match(/\.fanyi-translation\s*\{([^}]*)\}/)?.[1] ?? "";
const logo = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const popup = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
const options = readFileSync(new URL("../options.html", import.meta.url), "utf8");
const content = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");

describe("translation stylesheet", () => {
  it("pins inherited typography and color so host page rules cannot override them", () => {
    for (const property of ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"]) {
      expect(baseRule).toMatch(new RegExp(`(^|[\\s;])${property}\\s*:\\s*inherit\\s*!important`));
    }
    expect(baseRule).toMatch(/font-size:\s*calc\(1em \* var\(--fanyi-font-scale/);
  });
});

describe("brand logo", () => {
  it("uses the approved colors, centered glyph, and two-thirds type scale", () => {
    expect(logo).toContain('fill="#153B31"');
    expect(logo).toContain('fill="#B7E8CE"');
    expect(logo).toContain('font-size="85.333333"');
    expect(logo).toContain('text-anchor="middle"');
    expect(logo).toContain(">译</text>");
  });

  it("uses the logo asset throughout extension pages", () => {
    for (const html of [popup, options]) {
      expect(html).toContain('class="brand-mark" src="icons/icon-128.png"');
    }
  });

  it("uses the approved mark in injected page controls", () => {
    expect(css).toMatch(/\.fanyi-progress-toast::before[^}]*color:\s*#b7e8ce[^}]*background:\s*#153b31[^}]*font-size:\s*14\.666667px/is);
    expect(content).toMatch(/button \{[^}]*color: #b7e8ce; background: #153b31;[^}]*font: 700 21\.333333px\/1/is);
  });
});
