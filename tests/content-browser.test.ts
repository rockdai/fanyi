import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEXT_PROPERTIES = ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"];
const IDS = ["styled", "plain", "height", "lines", "flex", "grid", "grow", "next", "settle", "after", "ownbg", "item", "cell"];
const EXTERNALIZED = ["height", "lines", "flex", "grid", "grow", "ownbg"];

const FIXTURE = `
<script>
  const listeners = [];
  const settings = {};
  const fixedTranslations = { "Review the setup notes before you continue.": "请仔细阅读安装与配置的完整说明。" };
  window.__sent = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        window.__sent.push(message);
        if (message.type === "TRANSLATE_TEXTS") return { ok: true, translations: message.texts.map((text) => fixedTranslations[text] ?? "译文 " + text) };
      },
    },
    storage: { onChanged: { addListener: () => {} }, local: { get: async (defaults) => ({ ...defaults, ...settings }) } },
  };
  window.__toggle = () => listeners[0]({ type: "TOGGLE_PAGE" }, {}, () => {});
  window.__updateSettings = (patch) => new Promise((resolve) => {
    Object.assign(settings, patch);
    listeners[0]({ type: "SETTINGS_UPDATED" }, {}, resolve);
  });
</script>
<style>
  body { margin: 0; padding: 24px; color: #333; font-family: Georgia, serif; }
  .site div { font-family: Arial, sans-serif; color: #101010; font-weight: 400; font-style: normal; text-align: left; letter-spacing: 0; text-transform: none; }
  .dark { padding: 16px; background: #101010; }
  .dark p { color: #f5f5f5; font: italic 700 18px/28px Georgia, serif; text-align: center; letter-spacing: .05em; text-transform: uppercase; }
  .clamp-height { height: 24px; line-height: 24px; overflow: hidden; }
  .clamp-lines { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; }
  .flex { display: flex; gap: 14px; width: 600px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grow { width: 260px; height: 80px; overflow: visible; font: 16px/24px Arial, sans-serif; }
  .ownbg { color: #fff; background: #111; height: 24px; line-height: 24px; overflow: hidden; }
</style>
<div class="site">
  <div class="dark"><p id="styled">Styled paragraph on a dark card.</p></div>
  <p id="plain">A plain paragraph in the host page.</p>
  <p id="height" class="clamp-height">Single line card summary.</p>
  <h3 id="lines" class="clamp-lines">Headline clamped to a single line by webkit line clamp.</h3>
  <h2 id="flex" class="flex"><span>Flex heading title</span><span>badge</span></h2>
  <p id="grid" class="grid"><span>First column text</span><span>Second column text</span></p>
  <p id="grow" class="grow">Carefully read the installation and configuration instructions.</p>
  <p id="next">The paragraph that follows must stay clear of the translation above.</p>
  <p id="settle" class="grow">Review the setup notes before you continue.</p>
  <p id="after">Nothing below may be covered by the translation above.</p>
  <p id="ownbg" class="ownbg">Light text on the source's own dark background.</p>
  <ul><li id="item">List item text</li></ul>
  <table><tr><td id="cell">Table cell text</td></tr></table>
</div>`;

interface Report {
  id: string;
  inside: boolean;
  visible: boolean;
  sameBackground: boolean;
  bottom: number;
  fontRatio: number;
  mismatches: string[];
}

let browser: Browser;
let page: Page;

function measure(ids: string[]): Promise<Record<string, { top: number; height: number; text: string }>> {
  return page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing #${id}`);
    const rect = element.getBoundingClientRect();
    return [id, { top: rect.top + scrollY, height: rect.height, text: element.innerText.replace(/\s+/g, " ").trim() }];
  })), ids);
}

beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/content.ts", import.meta.url))], bundle: true, write: false, format: "iife", target: "chrome114", logLevel: "silent" });
  const css = readFileSync(new URL("../public/content.css", import.meta.url), "utf8");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});

afterAll(async () => {
  await browser?.close();
});

describe("immersive translation in a real page", () => {
  it("keeps every translation readable and styled like its source", async () => {
    const before = await measure(IDS);
    await page.evaluate("__toggle()");
    await page.waitForFunction((count) => document.querySelectorAll(".fanyi-translation").length === count && !document.querySelector(".fanyi-translation[data-loading]"), IDS.length);

    const sent = await page.evaluate<string[]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').flatMap((m) => m.texts)");
    expect(sent).toEqual(IDS.map((id) => before[id].text));

    const reports = await page.evaluate(({ ids, properties }): Report[] => {
      const effectiveBackground = (element: HTMLElement): string => {
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)") return color;
        }
        return "canvas";
      };
      return ids.map((id) => {
        const source = document.getElementById(id);
        const translation = document.querySelector(`#${id} .fanyi-translation, #${id} + .fanyi-translation`);
        if (!(source instanceof HTMLElement) || !(translation instanceof HTMLElement)) throw new Error(`missing translation for #${id}`);
        const sourceStyle = getComputedStyle(source);
        const style = getComputedStyle(translation);
        translation.scrollIntoView({ block: "center" });
        const rect = translation.getBoundingClientRect();
        return {
          id,
          inside: source.contains(translation),
          visible: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === translation,
          sameBackground: effectiveBackground(translation) === effectiveBackground(source),
          bottom: rect.bottom + scrollY,
          fontRatio: parseFloat(style.fontSize) / parseFloat(sourceStyle.fontSize),
          mismatches: properties.filter((property) => style.getPropertyValue(property) !== sourceStyle.getPropertyValue(property)),
        };
      });
    }, { ids: IDS, properties: TEXT_PROPERTIES });

    for (const report of reports) {
      expect(report, report.id).toMatchObject({ visible: true, sameBackground: true, mismatches: [], inside: !EXTERNALIZED.includes(report.id) });
      expect(report.fontRatio, report.id).toBeCloseTo(0.95, 2);
    }

    const after = await measure(["flex", "height", "lines", "grow", "next"]);
    for (const id of ["flex", "height", "lines", "grow"]) expect(after[id].height, id).toBe(before[id].height);
    const growTranslation = reports.find((report) => report.id === "grow");
    expect(growTranslation?.bottom).toBeLessThanOrEqual(after.next.top);
  });

  it("re-places translations after font scale and style changes", async () => {
    const probe = () => page.evaluate(() => {
      const source = document.getElementById("settle");
      const after = document.getElementById("after");
      const translation = document.querySelector("#settle .fanyi-translation, #settle + .fanyi-translation");
      if (!source || !after || !(translation instanceof HTMLElement)) throw new Error("missing #settle translation");
      return { inside: source.contains(translation), height: source.getBoundingClientRect().height, bottom: translation.getBoundingClientRect().bottom, afterTop: after.getBoundingClientRect().top };
    });

    expect(await probe()).toMatchObject({ inside: true, height: 80 });

    await page.evaluate("__updateSettings({ fontScale: 120 })");
    const scaled = await probe();
    expect(scaled).toMatchObject({ inside: false, height: 80 });
    expect(scaled.bottom).toBeLessThanOrEqual(scaled.afterTop);

    await page.evaluate("__updateSettings({ fontScale: 95, translationStyle: 'soft' })");
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelector("#settle > .fanyi-translation:not([data-loading])"));

    await page.evaluate("__updateSettings({ translationStyle: 'card' })");
    const carded = await probe();
    expect(carded).toMatchObject({ inside: false, height: 80 });
    expect(carded.bottom).toBeLessThanOrEqual(carded.afterTop);
  });

  it("restores the page when translation is turned off", async () => {
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation, [data-fanyi-processed]").length === 0);
    const restored = await measure(IDS);
    expect(restored.flex.text).toBe("Flex heading title badge");
  });
});
