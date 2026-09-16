import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEXT_PROPERTIES = ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"];
const IDS = ["styled", "plain", "height", "lines", "flex", "grid", "grow", "next", "settle", "after", "long", "ownbg", "item", "cell"];
const EXTERNALIZED = ["height", "lines", "flex", "grid", "grow", "ownbg"];

const FIXTURE = `
<script>
  const listeners = [];
  const storageListeners = [];
  // 老用户的存储只有沉浸式语言字段，没有划词语言字段
  const settings = { sourceLanguage: "de", targetLanguage: "en" };
  const shadows = new WeakMap();
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
    storage: {
      onChanged: { addListener: (listener) => storageListeners.push(listener) },
      local: {
        get: async () => ({ ...settings }),
        set: async (patch) => {
          Object.assign(settings, patch);
          storageListeners.forEach((listener) => listener({}, "local"));
        },
      },
    },
  };
  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = nativeAttachShadow.call(this, init);
    shadows.set(this, root);
    return root;
  };
  window.__toggle = () => listeners[0]({ type: "TOGGLE_PAGE" }, {}, () => {});
  window.__updateSettings = (patch) => new Promise((resolve) => {
    Object.assign(settings, patch);
    listeners[0]({ type: "SETTINGS_UPDATED" }, {}, resolve);
  });
  window.__stored = () => settings;
  window.__overlay = (kind) => {
    const host = document.querySelector('[data-fanyi-root="' + kind + '"]');
    return host ? shadows.get(host) : null;
  };
  window.__select = (id) => {
    const element = document.getElementById(id);
    element.scrollIntoView({ block: "center" });
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = element.getBoundingClientRect();
    const init = { bubbles: true, clientX: rect.right, clientY: rect.bottom };
    element.dispatchEvent(new PointerEvent("pointerdown", init));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", init));
  };
  window.__popup = () => {
    const root = window.__overlay("selection");
    if (!root) return null;
    const host = root.host;
    const result = root.querySelector(".result");
    const rect = result.getBoundingClientRect();
    const actions = root.querySelector(".actions").getBoundingClientRect();
    return {
      text: result.textContent,
      loading: result.classList.contains("loading"),
      fontSize: parseFloat(getComputedStyle(result).fontSize),
      brand: Boolean(root.querySelector(".brand")),
      visible: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === host,
      actionsVisible: document.elementFromPoint(actions.left + actions.width / 2, actions.top + actions.height / 2) === host,
      cardBottom: root.querySelector(".card").getBoundingClientRect().bottom,
      resultScrollable: result.scrollHeight > result.clientHeight,
      marked: host.dataset.mark === "kept",
      focused: document.activeElement === host,
      from: root.querySelector(".from").value,
      to: root.querySelector(".to").value,
    };
  };
  window.__markAndFocusSource = () => {
    const root = window.__overlay("selection");
    root.host.dataset.mark = "kept";
    root.querySelector(".from").focus();
  };
  window.__chooseTarget = (code) => {
    const select = window.__overlay("selection").querySelector(".to");
    select.value = code;
    select.dispatchEvent(new Event("change"));
  };
  window.__pressTrigger = () => {
    const button = window.__overlay("trigger").querySelector("button");
    const init = { bubbles: true, composed: true };
    button.dispatchEvent(new PointerEvent("pointerdown", init));
    button.dispatchEvent(new MouseEvent("mouseup", init));
    button.click();
  };
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
  <p id="long">Long-form reading is where translation quality matters most. A paragraph that runs for several sentences gives the reader context, rhythm, and the small connective phrases that make an argument feel whole. When a tool translates such a passage, it must keep every clause in order, preserve the names and numbers exactly, and avoid inventing detail that the author never wrote. It should also stay out of the way: the translation belongs beside the text, in the same typeface and colour, so that the eye can move between the two without effort. Anything less breaks the sense of immersion that makes bilingual reading worthwhile in the first place.</p>
  <p id="ownbg" class="ownbg">Light text on the source's own dark background.</p>
  <ul><li id="item">List item text</li></ul>
  <table><tr><td id="cell">Table cell text</td></tr></table>
</div>`;

interface SelectionPopup {
  text: string;
  loading: boolean;
  fontSize: number;
  brand: boolean;
  visible: boolean;
  actionsVisible: boolean;
  cardBottom: number;
  resultScrollable: boolean;
  marked: boolean;
  focused: boolean;
  from: string;
  to: string;
}

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

describe("selection translation in a real page", () => {
  const requestCount = (sourceLanguage: string, targetLanguage: string) => page.evaluate<number>(`window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS' && m.sourceLanguage === '${sourceLanguage}' && m.targetLanguage === '${targetLanguage}').length`);
  const lastRequest = () => page.evaluate<{ sourceLanguage: string; targetLanguage: string; texts: string[] }>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').at(-1)");
  const settledPopup = async (): Promise<SelectionPopup> => {
    await page.waitForFunction("__popup() && !__popup().loading");
    return page.evaluate<SelectionPopup>("__popup()");
  };

  it("translates a selection while page translation is off, using the legacy language pair", async () => {
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(0);
    await page.evaluate("__select('plain')");
    const popup = await settledPopup();
    expect(popup).toMatchObject({ text: "译文 A plain paragraph in the host page.", brand: false, visible: true, from: "de", to: "en" });
    expect(popup.fontSize).toBeGreaterThanOrEqual(15);
    expect(await lastRequest()).toMatchObject({ sourceLanguage: "de", targetLanguage: "en" });
  });

  it("keeps the popup and its focus while arrow keys are used inside it", async () => {
    const before = await requestCount("de", "en");
    await page.evaluate("__markAndFocusSource()");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    expect(await page.evaluate<SelectionPopup>("__popup()")).toMatchObject({ marked: true, focused: true });
    expect(await requestCount("de", "en")).toBe(before);
  });

  it("re-translates with the language picked in the popup and remembers it", async () => {
    await page.evaluate("__chooseTarget('ja')");
    expect(await settledPopup()).toMatchObject({ text: "译文 A plain paragraph in the host page.", to: "ja" });
    expect(await lastRequest()).toMatchObject({ targetLanguage: "ja" });
    expect(await page.evaluate("__stored().selectionTargetLanguage")).toBe("ja");

    await page.evaluate("__select('next')");
    expect(await settledPopup()).toMatchObject({ text: "译文 The paragraph that follows must stay clear of the translation above.", to: "ja" });
  });

  it("waits for the trigger button in button mode", async () => {
    await page.evaluate("__updateSettings({ selectionTrigger: 'button' })");
    await page.evaluate("__select('after')");
    await page.waitForFunction("__overlay('trigger')");
    expect(await page.evaluate("Boolean(__overlay('selection'))")).toBe(false);

    await page.evaluate("__pressTrigger()");
    expect(await settledPopup()).toMatchObject({ text: "译文 Nothing below may be covered by the translation above.", visible: true });
    expect(await page.evaluate("Boolean(__overlay('trigger'))")).toBe(false);
  });

  it("keeps a long translation scrollable and the controls in view in a short window", async () => {
    await page.setViewportSize({ width: 1000, height: 480 });
    await page.evaluate("__updateSettings({ selectionTrigger: 'auto' })");
    await page.evaluate("__select('long')");
    const popup = await settledPopup();
    expect(popup).toMatchObject({ visible: true, actionsVisible: true, resultScrollable: true });
    expect(popup.cardBottom).toBeLessThanOrEqual(480);
  });

  it("stays quiet when selection translation is disabled", async () => {
    await page.evaluate("__updateSettings({ selectionEnabled: false })");
    await page.evaluate("__select('plain')");
    await page.waitForTimeout(400);
    expect(await page.evaluate("Boolean(__overlay('selection') || __overlay('trigger'))")).toBe(false);
  });
});
