import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/content.css", import.meta.url), "utf8");
const baseRule = css.match(/\.fanyi-translation\s*\{([^}]*)\}/)?.[1] ?? "";
const logo = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const popup = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
const options = readFileSync(new URL("../options.html", import.meta.url), "utf8");
const content = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
const listing = readFileSync(new URL("../store/listing.md", import.meta.url), "utf8");

describe("translation stylesheet", () => {
  it("pins inherited typography and color so host page rules cannot override them", () => {
    for (const property of ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"]) {
      expect(baseRule).toMatch(new RegExp(`(^|[\\s;])${property}\\s*:\\s*inherit\\s*!important`));
    }
    expect(baseRule).toMatch(/font-size:\s*calc\(1em \* var\(--fanyi-font-scale/);
  });

  it("renders the retry link as underlined inherited text", () => {
    expect(css).toMatch(/\.fanyi-translation \.fanyi-retry \{[^}]*color:\s*inherit\s*!important[^}]*text-decoration:\s*underline\s*!important/);
  });
});

describe("brand logo", () => {
  it("uses the approved colors, centered glyph, and two-thirds type scale", () => {
    expect(logo).toMatch(/<rect [^>]*fill="#B7E8CE"/);
    expect(logo).toMatch(/<text [^>]*fill="#153B31"/);
    expect(logo).toContain('font-family="Songti SC, SimSun, serif"');
    expect(logo).toContain('font-size="85.333333"');
    expect(logo).toContain('font-weight="900"');
    expect(logo).toContain('y="63"');
    expect(logo).toContain('text-anchor="middle"');
    expect(logo).toContain(">译</text>");
  });

  it("uses the logo asset on the settings page", () => {
    expect(options).toContain('class="brand-mark" src="icons/icon-128.png"');
  });

  it("uses the approved mark in injected page controls", () => {
    expect(css).toMatch(/\.fanyi-notice::before[^}]*background:\s*#b7e8ce/is);
    expect(css).toMatch(/\.fanyi-notice::after[^}]*top:\s*calc\(50% - 1px\)[^}]*color:\s*#153b31[^}]*font-family:\s*"Songti SC", SimSun, serif[^}]*font-weight:\s*900[^}]*font-size:\s*14\.666667px/is);
    expect(content).toMatch(/button \{[^}]*color: #153b31; background: #b7e8ce;[^}]*font: 900 21\.333333px\/1 "Songti SC",SimSun,serif/is);
    expect(content).toMatch(/span \{ transform: translateY\(-1px\); \}/);
  });
});

describe("settings page", () => {
  it("ends the general section with the reset button and shows no eyebrow label above the title", () => {
    const general = options.match(/<section class="settings-section active" id="general">([\s\S]*?)<\/section>/)?.[1] ?? "";
    expect(general.trimEnd()).toMatch(/id="reset-settings">恢复默认设置<\/button>$/);
    expect(options.match(/id="reset-settings"/g)).toHaveLength(1);
    expect(options).not.toContain("PREFERENCES");
  });
});

describe("popup panel", () => {
  it("shows the selection switch, the language pair, the service picker and the translate button in that order", () => {
    const controls = [...popup.matchAll(/id="(selection-enabled|source-language|target-language|provider|translate-page)"/g)].map(([, id]) => id);
    expect(controls).toEqual(["selection-enabled", "source-language", "target-language", "provider", "translate-page"]);
    expect(popup).toContain('<option value="google">');
    expect(popup).toContain('<option value="openai">');
  });

  it("drops the brand header, the header settings button and the translation style switcher", () => {
    for (const removed of ["brand", "open-settings", "data-style", "status-card", "engine-badge"]) {
      expect(popup).not.toContain(removed);
    }
  });
});

describe("store listing", () => {
  it("names no third-party model vendor, which the store rejected as keyword spam", () => {
    for (const vendor of ["DeepSeek", "Kimi", "智谱", "通义千问", "Qwen", "Gemini", "OpenRouter", "vLLM"]) {
      expect(listing).not.toContain(vendor);
    }
  });

  it("still says which interface a self-hosted service has to speak", () => {
    const description = listing.match(/\*\*详细说明\*\*：\n\n```\n([\s\S]*?)```/)?.[1] ?? "";
    expect(description).toContain("OpenAI 兼容接口");
    expect(description).toContain("API Key 只保存在浏览器本地");
  });
});
