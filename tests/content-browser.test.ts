import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitText } from "../src/paragraphs";

const TEXT_PROPERTIES = ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"];
const IDS = ["styled", "plain", "height", "lines", "flex", "grid", "grow", "next", "settle", "after", "long", "ownbg", "item", "cell", "far", "linkpara", "side", "sidediv"];
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
  window.__unchanged = [];
  window.__cancelled = 0;
  window.__pending = [];
  window.__holdRequests = false;
  window.__detections = [];
  window.__holdDetect = false;
  window.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        window.__sent.push(message);
        if (window.__delay) await new Promise((resolve) => setTimeout(resolve, window.__delay));
        if (message.type !== "TRANSLATE_TEXTS") return;
        if (window.__failAll || (window.__failText && message.texts.some((text) => text.startsWith(window.__failText)))) throw new Error("request failed on purpose");
        const reply = () => ({ ok: true, translations: message.texts.map((text) => window.__unchanged.includes(text) ? text : fixedTranslations[text] ?? "译文 " + text) });
        if (!window.__holdRequests) return reply();
        return new Promise((resolve, reject) => window.__pending.push({ texts: message.texts, resolve: () => resolve(reply()), reject: () => reject(new Error("held request failed")) }));
      },
      connect: () => {
        const listeners = [];
        let open = true;
        let answered = false;
        return {
          onMessage: { addListener: (listener) => listeners.push(listener) },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {
            if (open && !answered) window.__cancelled += 1;
            open = false;
          },
          postMessage: (message) => {
            const deliver = (response) => {
              if (!open) return;
              answered = true;
              listeners.forEach((listener) => listener(response));
            };
            window.chrome.runtime.sendMessage(message).then(deliver, (error) => deliver({ ok: false, error: error.message }));
          },
        };
      },
    },
    i18n: {
      detectLanguage: async (text) => {
        if (window.__detectDelay) await new Promise((resolve) => setTimeout(resolve, window.__detectDelay));
        if (window.__holdDetect) await new Promise((resolve) => window.__detections.push(resolve));
        return { isReliable: window.__detectReliable ?? true, languages: [{ language: window.__detectedByText?.[text] ?? window.__detected ?? "en", percentage: 92 }] };
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
  document.title = "Hello world";
  window.__toggle = () => listeners[0]({ type: "TOGGLE_PAGE" }, {}, () => {});
  window.__toggleAsync = () => new Promise((resolve) => listeners[0]({ type: "TOGGLE_PAGE" }, {}, resolve));
  window.__restart = () => listeners[0]({ type: "RESTART_TRANSLATION" }, {}, () => {});
  window.__state = () => new Promise((resolve) => listeners[0]({ type: "GET_PAGE_STATE" }, {}, resolve));
  window.__translation = (id) => {
    const element = document.querySelector("#" + id + " .fanyi-translation, #" + id + " + .fanyi-translation, .fanyi-translation + #" + id);
    const translation = element?.classList.contains("fanyi-translation") ? element : element?.previousElementSibling;
    if (!translation || translation.dataset.loading !== undefined) return null;
    return { text: translation.textContent, whiteSpace: getComputedStyle(translation).whiteSpace };
  };
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
  <div style="height: 1500px"></div>
  <p id="far">A paragraph far below the fold.</p>
  <p id="linkpara">Paragraph with <a id="innerlink" href="#">an inline link</a> inside.</p>
  <aside><p id="side">Sidebar paragraph text.</p><div id="sidediv">Sidebar div text.</div></aside>
  <nav><p id="menu">Navigation menu text.</p><a id="navlink" href="#">Navigation link text.</a></nav>
  <footer><span id="footspan">Footer span text.</span></footer>
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
let bundleText: string;
let css: string;

async function openPage(settingsLiteral: string): Promise<Page> {
  const fresh = await browser.newPage();
  await fresh.setContent(FIXTURE.replace('const settings = { sourceLanguage: "de", targetLanguage: "en" };', `const settings = ${settingsLiteral};`));
  await fresh.addStyleTag({ content: css });
  await fresh.addScriptTag({ content: bundleText });
  return fresh;
}

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
  bundleText = bundle.outputFiles[0].text;
  css = readFileSync(new URL("../public/content.css", import.meta.url), "utf8");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
}, 90000);

afterAll(async () => {
  await browser?.close();
});

describe("immersive translation in a real page", () => {
  it("keeps every translation readable and styled like its source", async () => {
    const before = await measure(IDS);
    await page.evaluate("__toggle()");
    await page.waitForFunction((count) => document.querySelectorAll(".fanyi-translation").length === count && !document.querySelector(".fanyi-translation[data-loading]"), IDS.length);

    const requests = await page.evaluate<string[][]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').map((m) => m.texts)");
    expect(requests).toContainEqual(["Hello world"]);
    expect(requests.filter((texts) => texts[0] !== "Hello world").flat()).toEqual(IDS.map((id) => before[id].text));
    expect(requests.every((texts) => texts.length <= 4)).toBe(true);
    expect(await page.evaluate("document.title")).toBe("译文 Hello world | Hello world");
    expect(await page.evaluate("Boolean(__translation('menu'))")).toBe(false);

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
    expect(await page.evaluate("document.title")).toBe("Hello world");
  });
});

describe("translation settings in a real page", () => {
  const settled = () => page.waitForFunction(() => document.querySelector(".fanyi-translation") && !document.querySelector(".fanyi-translation[data-loading]"));
  const restart = async (patch: Record<string, unknown>) => {
    await page.evaluate(`__updateSettings(${JSON.stringify(patch)})`);
    await page.evaluate("__restart()");
    await settled();
  };
  const translation = (id: string) => page.evaluate<{ text: string; whiteSpace: string } | null>(`__translation('${id}')`);

  it("translates the first characters eagerly and the rest when scrolled into view", async () => {
    await page.evaluate("window.scrollTo(0, 0); __updateSettings({ eagerCharacters: 60 })");
    await page.evaluate("__toggle()");
    await settled();
    expect(await translation("plain")).toMatchObject({ text: "译文 A plain paragraph in the host page." });
    expect(await translation("far")).toBeNull();

    await page.evaluate("document.getElementById('far').scrollIntoView()");
    await page.waitForFunction("__translation('far')");
    expect(await translation("far")).toMatchObject({ text: "译文 A paragraph far below the fold." });

    await page.evaluate("window.scrollTo(0, 0)");
    await restart({ translateFullPage: true });
    expect(await translation("far")).toMatchObject({ text: "译文 A paragraph far below the fold." });
    await page.evaluate("__updateSettings({ eagerCharacters: 4999, translateFullPage: false })");
  });

  it("splits long paragraphs so every request stays within the character cap", async () => {
    const originalLong = FIXTURE.match(/<p id="long">([^<]+)<\/p>/)?.[1] ?? "";
    await page.evaluate("window.__sent.length = 0");
    await restart({ maxCharsPerRequest: 100 });
    const requests = await page.evaluate<string[][]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').map((m) => m.texts)");
    expect(requests.every((texts) => texts.join("").length <= 100)).toBe(true);
    expect(requests.flat().length).toBeGreaterThan(IDS.length);
    expect(await translation("long")).toMatchObject({ text: expect.stringMatching(/^译文 /) });
    expect((await translation("long"))?.text.replace(/译文 /g, "")).toBe(originalLong);
    expect(await page.evaluate("document.querySelectorAll('#long .fanyi-translation, #long + .fanyi-translation').length")).toBe(1);
    await page.evaluate("__updateSettings({ maxCharsPerRequest: 2000 })");
  });

  it("places the translation before the source when asked, live and after restart", async () => {
    await restart({ translationFirst: true });
    const before = await page.evaluate(() => ({
      plainFirst: document.getElementById("plain")?.firstElementChild?.matches(".fanyi-translation[data-position='before']"),
      growBefore: document.getElementById("grow")?.previousElementSibling?.matches(".fanyi-translation[data-position='before']"),
      margin: getComputedStyle(document.querySelector("#plain > .fanyi-translation") as Element).marginBottom,
    }));
    expect(before).toEqual({ plainFirst: true, growBefore: true, margin: expect.not.stringMatching(/^0px$/) });

    await page.evaluate("__updateSettings({ translationFirst: false })");
    const after = await page.evaluate(() => ({
      plainLast: document.getElementById("plain")?.lastElementChild?.matches(".fanyi-translation[data-position='after']"),
      growAfter: document.getElementById("grow")?.nextElementSibling?.matches(".fanyi-translation[data-position='after']"),
    }));
    expect(after).toEqual({ plainLast: true, growAfter: true });
  });

  it("honours title, sidebar, all-areas and minimum length settings", async () => {
    await restart({ translateTitle: false, translateAside: false });
    expect(await page.evaluate("document.title")).toBe("Hello world");
    expect(await translation("side")).toBeNull();

    await restart({ translateAllAreas: true });
    expect(await translation("side")).not.toBeNull();
    expect(await translation("menu")).toMatchObject({ text: "译文 Navigation menu text." });

    await restart({ translateAllAreas: false, translateAside: true, minParagraphLength: 20 });
    expect(await translation("item")).toBeNull();
    expect(await translation("plain")).not.toBeNull();
    await page.evaluate("__updateSettings({ translateTitle: true, minParagraphLength: 2 })");
  });

  it("collects links, divs and spans in opened regions without translating nested text twice", async () => {
    await restart({});
    expect(await translation("sidediv")).toMatchObject({ text: "译文 Sidebar div text." });
    expect(await translation("navlink")).toBeNull();
    expect(await translation("footspan")).toBeNull();

    await restart({ translateAllAreas: true });
    expect(await translation("navlink")).toMatchObject({ text: "译文 Navigation link text." });
    expect(await translation("footspan")).toMatchObject({ text: "译文 Footer span text." });
    expect(await translation("linkpara")).toMatchObject({ text: "译文 Paragraph with an inline link inside." });
    expect(await page.evaluate("document.querySelectorAll('#linkpara .fanyi-translation').length")).toBe(1);
    expect(await page.evaluate("document.querySelectorAll('#innerlink .fanyi-translation').length")).toBe(0);

    await restart({ translateAllAreas: false, translateAside: false });
    expect(await translation("sidediv")).toBeNull();
    expect(await translation("side")).toBeNull();
    await page.evaluate("__updateSettings({ translateAside: true })");
  });

  it("leaves a title the page changed itself alone", async () => {
    await restart({});
    expect(await page.evaluate("document.title")).toBe("译文 Hello world | Hello world");
    await page.evaluate("document.title = 'Second article from client-side navigation'");
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    expect(await page.evaluate("document.title")).toBe("Second article from client-side navigation");

    await page.evaluate("document.title = 'Hello world'; window.__holdRequests = true; __restart()");
    await page.waitForFunction("window.__pending.some((p) => p.texts[0] === 'Hello world')");
    await page.evaluate("document.title = 'Third article'; window.__holdRequests = false; window.__pending.splice(0).forEach((p) => p.resolve())");
    await settled();
    expect(await page.evaluate("document.title")).toBe("Third article");
    await page.evaluate("document.title = 'Hello world'");
  });

  it("breaks long translations into sentences when enabled", async () => {
    await restart({ sentenceBreaks: true });
    const long = await translation("long");
    expect(long?.whiteSpace).toBe("pre-line");
    expect(long?.text.split("\n").length).toBeGreaterThan(3);
    expect(await translation("plain")).toMatchObject({ whiteSpace: "normal" });
    await page.evaluate("__updateSettings({ sentenceBreaks: false })");
  });

  it("shows a spinner or nothing while a translation loads", async () => {
    const probe = () => page.evaluate(() => {
      const placeholder = document.querySelector(".fanyi-translation[data-loading]");
      if (!placeholder) return null;
      return { display: getComputedStyle(placeholder).display, spinner: getComputedStyle(placeholder, "::before").animationName };
    });
    await page.evaluate("window.__delay = 250; __updateSettings({ loadingStyle: 'none' })");
    await page.evaluate("__restart()");
    await page.waitForFunction(() => document.querySelector(".fanyi-translation[data-loading]"));
    expect(await probe()).toEqual({ display: "none", spinner: "none" });
    await settled();

    await page.evaluate("__updateSettings({ loadingStyle: 'spinner' })");
    await page.evaluate("__restart()");
    await page.waitForFunction(() => document.querySelector(".fanyi-translation[data-loading]"));
    expect(await probe()).toEqual({ display: "block", spinner: "fanyi-spin" });
    await settled();
    await page.evaluate("window.__delay = 0");
  }, 15000);

  it("shows no progress card while paragraphs are being translated", async () => {
    await page.evaluate("window.__holdRequests = true; __restart()");
    await page.waitForFunction("window.__pending.length > 0");
    expect(await page.evaluate("document.querySelector('.fanyi-notice') === null")).toBe(true);
    await page.evaluate("window.__holdRequests = false; window.__pending.splice(0).forEach((p) => p.resolve())");
    await settled();
  });

  it("refuses to translate a page that is already in the target language", async () => {
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__updateSettings({ sourceLanguage: 'auto' })");
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelector(".fanyi-notice"));
    expect(await page.evaluate("document.querySelector('.fanyi-notice').textContent")).toBe("页面语言与目标语言相同，无需翻译");
    expect(await page.evaluate("__state()")).toMatchObject({ active: false, translatedCount: 0 });
    // 点「翻译」即使本页不需要翻译也会打开全局开关，正文可能在框架里；这里先关掉再继续
    expect(await page.evaluate("__state()")).toMatchObject({ enabled: true });
    await page.evaluate("__toggle()");

    await page.evaluate("__updateSettings({ detectSameLanguage: false })");
    await page.evaluate("__toggle()");
    await settled();
    expect(await page.evaluate("__state()")).toMatchObject({ active: true });

    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__updateSettings({ sourceLanguage: 'de', detectSameLanguage: true })");
  });

  it("replies with the settled state after async language detection and never queues twice", async () => {
    await page.evaluate("window.__detected = 'de'; window.__detectDelay = 300; window.__sent.length = 0; __updateSettings({ sourceLanguage: 'auto' })");
    expect(await page.evaluate("__toggleAsync()")).toMatchObject({ active: true });
    await settled();
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(IDS.length);

    await page.evaluate("window.__sent.length = 0; __restart(); __restart()");
    await settled();
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(IDS.length);
    expect(await page.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS' && m.texts.includes('A plain paragraph in the host page.')).length")).toBe(1);

    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__toggle(); __toggle()");
    await page.waitForTimeout(600);
    expect(await page.evaluate("__state()")).toMatchObject({ active: false, translatedCount: 0 });
    await page.evaluate("window.__detectDelay = 0; __updateSettings({ sourceLanguage: 'de' })");
  });

  it("ignores a failure of a request from a round that was already restarted", async () => {
    await page.evaluate("window.__holdRequests = true; __updateSettings({ maxParagraphsPerRequest: 2 })");
    await page.evaluate("__restart()");
    // 三个批次并发在途
    await page.waitForFunction("window.__pending.filter((p) => p.texts.length === 2).length === 3");
    await page.evaluate("__restart()");
    await page.waitForFunction("window.__pending.filter((p) => p.texts.length === 2).length === 6");
    await page.evaluate("window.__pending.find((p) => p.texts.length === 2).reject()");
    await page.waitForTimeout(100);
    await page.evaluate("window.__holdRequests = false; window.__pending.splice(0).forEach((p) => p.resolve())");
    await settled();
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(IDS.length);
    expect(await page.evaluate("document.querySelectorAll('[data-fanyi-processed]').length")).toBe(IDS.length);
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__updateSettings({ maxParagraphsPerRequest: 4 })");
  });

  it("still cancels a startup that is detecting after an older startup has returned", async () => {
    await page.evaluate("window.__holdDetect = true; window.__detected = 'de'; window.__sent.length = 0; __updateSettings({ sourceLanguage: 'auto' })");
    await page.evaluate("__restart()");
    await page.waitForFunction("window.__detections.length === 1");
    await page.evaluate("__restart()");
    await page.waitForFunction("window.__detections.length === 2");
    await page.evaluate("window.__detections.shift()()");
    await page.waitForTimeout(50);
    await page.evaluate("__toggle()");
    await page.waitForTimeout(50);
    await page.evaluate("window.__holdDetect = false; window.__detections.splice(0).forEach((resolve) => resolve())");
    await page.waitForTimeout(400);
    expect(await page.evaluate("__state()")).toMatchObject({ active: false, translatedCount: 0 });
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(0);
    expect(await page.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length")).toBe(0);
    await page.evaluate("__updateSettings({ sourceLanguage: 'de' })");
  });

  it("keeps a failed paragraph marked so a rescan never re-sends its error text", async () => {
    await page.evaluate("window.__failText = 'A paragraph that runs'");
    await restart({ maxCharsPerRequest: 100 });
    expect(await translation("long")).toMatchObject({ text: expect.stringMatching(/^翻译失败：/) });
    expect(await page.evaluate("document.querySelectorAll('#long .fanyi-translation, #long + .fanyi-translation').length")).toBe(1);

    await page.evaluate("window.__failText = null; window.__sent.length = 0; document.getElementById('plain').insertAdjacentHTML('afterend', '<p id=\"added\">Added paragraph after the failure.</p>')");
    await page.waitForFunction("__translation('added')");
    await page.evaluate("document.getElementById('long').scrollIntoView()");
    await page.waitForTimeout(400);
    await settled();
    await page.evaluate("window.scrollTo(0, 0)");
    expect(await page.evaluate("document.querySelectorAll('#long .fanyi-translation, #long + .fanyi-translation').length")).toBe(1);
    expect(await page.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').flatMap((m) => m.texts).some((text) => text.includes('翻译失败'))")).toBe(false);
    await page.evaluate("document.getElementById('added').remove()");
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__updateSettings({ maxCharsPerRequest: 2000 })");
  });

  it("stops sending remaining chunks once translation is stopped or restarted", async () => {
    const originalLong = FIXTURE.match(/<p id="long">([^<]+)<\/p>/)?.[1] ?? "";
    const requestCount = () => page.evaluate<number>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length");
    await page.evaluate("window.__holdRequests = true; window.__sent.length = 0; window.__cancelled = 0; __updateSettings({ maxCharsPerRequest: 100, minParagraphLength: 300, translateTitle: false })");
    await page.evaluate("__restart()");
    await page.waitForFunction("window.__pending.length === 1");
    expect(await page.evaluate("__toggleAsync()")).toMatchObject({ active: false });
    // 停止时断开在途请求的端口，后台不会再为它重试
    expect(await page.evaluate("window.__cancelled")).toBe(1);
    await page.evaluate("window.__pending.splice(0).forEach((p) => p.resolve())");
    await page.waitForTimeout(300);
    expect(await requestCount()).toBe(1);
    expect(await page.evaluate("__state()")).toMatchObject({ active: false, translating: false, translatedCount: 0 });

    await page.evaluate("__restart()");
    await page.waitForFunction("window.__pending.length === 1");
    await page.evaluate("__restart()");
    await page.waitForFunction("window.__pending.length === 2");
    expect(await page.evaluate("window.__cancelled")).toBe(2);
    await page.evaluate("window.__pending.shift().resolve()");
    await page.waitForTimeout(300);
    expect(await requestCount()).toBe(3);
    await page.evaluate("window.__holdRequests = false; window.__pending.splice(0).forEach((p) => p.resolve())");
    await settled();
    expect((await translation("long"))?.text.replace(/译文 /g, "")).toBe(originalLong);
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(1);
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__updateSettings({ maxCharsPerRequest: 2000, minParagraphLength: 2, translateTitle: true })");
  });

  it("splits a long title through the same request limit", async () => {
    const longTitle = FIXTURE.match(/<p id="long">([^<]+)<\/p>/)?.[1] ?? "";
    await page.evaluate(`document.title = ${JSON.stringify(longTitle)}; window.__sent.length = 0`);
    await restart({ maxCharsPerRequest: 100 });
    await page.waitForFunction(() => document.title.startsWith("译文 "));
    const requests = await page.evaluate<string[][]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').map((m) => m.texts)");
    expect(requests.every((texts) => texts.join("").length <= 100)).toBe(true);
    expect(await page.evaluate("document.title.replace(/译文 /g, '')")).toBe(`${longTitle} | ${longTitle}`);
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    expect(await page.evaluate("document.title")).toBe(longTitle);
    await page.evaluate("document.title = 'Hello world'; __updateSettings({ maxCharsPerRequest: 2000 })");
  });

  it("keeps translating later batches after one batch fails and leaves failures out of the count", async () => {
    await page.evaluate("window.__failText = 'The paragraph that follows'; window.__sent.length = 0");
    await page.evaluate("__restart()");
    await settled();
    expect(await page.evaluate("document.querySelector('#flex .fanyi-translation, #flex + .fanyi-translation')?.dataset.error")).toBe("true");
    expect(await page.evaluate("document.querySelector('#next .fanyi-translation, #next + .fanyi-translation')?.textContent")).toBe("翻译失败：request failed on purpose 重试");
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation[data-error] a.fanyi-retry').length")).toBe(4);
    expect(await translation("settle")).toMatchObject({ text: "请仔细阅读安装与配置的完整说明。" });
    expect(await translation("sidediv")).toMatchObject({ text: "译文 Sidebar div text." });
    expect(await page.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: IDS.length - 4 });
    expect(await page.evaluate("document.querySelectorAll('[data-fanyi-processed]').length")).toBe(IDS.length);
    expect(await page.evaluate("document.querySelector('.fanyi-notice')?.textContent")).toBe("4 个段落翻译失败：request failed on purpose");

    await page.evaluate("window.__failText = null; document.querySelector('#next .fanyi-translation a.fanyi-retry').click()");
    await page.waitForFunction("document.querySelector('#next .fanyi-translation:not([data-loading])')?.textContent.startsWith('译文')");
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation[data-error]').length")).toBe(3);
    expect(await page.evaluate("__state()")).toMatchObject({ translating: false, translatedCount: IDS.length - 3 });
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
  });

  it("pauses after consecutive failed batches, keeps the rest queued and resumes from a retry link", async () => {
    await page.evaluate("window.__failAll = true; window.__sent.length = 0; __updateSettings({ translateTitle: false })");
    await page.evaluate("__restart()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation[data-error]").length >= 12 && !document.querySelector(".fanyi-translation[data-loading]"));
    await page.waitForTimeout(200);
    const sent = await page.evaluate<number>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length");
    // 并发中的批次不计入连续失败，最坏比 3 多发 2 批
    expect(sent).toBeGreaterThanOrEqual(3);
    expect(sent).toBeLessThanOrEqual(5);
    const sentParagraphs = await page.evaluate<number>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').reduce((n, m) => n + m.texts.length, 0)");
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation[data-error] a.fanyi-retry').length")).toBe(sentParagraphs);
    expect(await page.evaluate("document.querySelectorAll('[data-fanyi-processed]').length")).toBe(IDS.length);
    expect(await page.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: 0 });

    await page.evaluate("window.__failAll = false; document.querySelector('#plain .fanyi-translation a.fanyi-retry').click()");
    await page.waitForFunction("document.querySelector('#plain .fanyi-translation:not([data-loading])')?.textContent.startsWith('译文')");
    await settled();
    // 重试成功后队列里剩下的段落跟着翻完，其余失败段落保留错误和重试链接
    expect(await page.evaluate("document.querySelectorAll('.fanyi-translation[data-error]').length")).toBe(sentParagraphs - 1);
    expect(await page.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: IDS.length - sentParagraphs + 1 });
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("__updateSettings({ translateTitle: true })");
  });

  it("still translates a paragraph scrolled into view while a run is paused on failures", async () => {
    await page.evaluate("window.scrollTo(0, 0); window.__holdRequests = true; window.__sent.length = 0; __updateSettings({ maxParagraphsPerRequest: 1, eagerCharacters: 200, translateTitle: false })");
    await page.evaluate("__restart()");
    await page.waitForFunction("window.__pending.length === 3");
    // 等 IntersectionObserver 先把首屏内的懒加载段落排进队列，之后的失败计数才稳定
    await page.waitForTimeout(200);
    for (let index = 0; index < 3; index += 1) {
      await page.evaluate("window.__pending.shift().reject()");
      await page.waitForTimeout(50);
    }
    // 连续失败 3 次进入暂停，此时仍有 2 批在途
    expect(await page.evaluate("window.__pending.length")).toBe(2);
    await page.evaluate("document.getElementById('far').scrollIntoView()");
    await page.waitForFunction("window.__pending.some((p) => p.texts[0] === 'A paragraph far below the fold.')");
    await page.evaluate("window.__holdRequests = false; window.__pending.splice(0).forEach((p) => (p.texts[0] === 'A paragraph far below the fold.' ? p.resolve() : p.reject()))");
    await settled();
    expect(await translation("far")).toMatchObject({ text: "译文 A paragraph far below the fold." });
    expect(await page.evaluate("__state()")).toMatchObject({ active: true, translating: false });
    await page.evaluate("__toggle()");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await page.evaluate("window.scrollTo(0, 0); __updateSettings({ maxParagraphsPerRequest: 4, eagerCharacters: 4999, translateTitle: true })");
  });
});

describe("page language", () => {
  it("judges by the text it is about to translate, not by the language the page declares", async () => {
    const fresh = await openPage('{ sourceLanguage: "auto", targetLanguage: "zh-CN" }');
    // 邮箱一类应用把界面语言写在 <html lang> 上，正文却是另一种语言
    await fresh.evaluate("document.documentElement.lang = 'zh-CN'; window.__detected = 'en'; __toggle()");
    await fresh.waitForFunction(() => document.querySelector(".fanyi-translation") && !document.querySelector(".fanyi-translation[data-loading]"));
    expect(await fresh.evaluate("__state()")).toMatchObject({ active: true });
    expect(await fresh.evaluate("Boolean(document.querySelector('.fanyi-notice'))")).toBe(false);
    await fresh.close();
  });

  it("keeps the script the page declares when the detector only reports the language", async () => {
    const fresh = await openPage('{ sourceLanguage: "auto", targetLanguage: "zh-CN" }');
    // 检测分不出简繁，只会说“中文”，繁体正文翻成简体仍然要做
    await fresh.evaluate("document.documentElement.lang = 'zh-TW'; window.__detected = 'zh'; __toggle()");
    await fresh.waitForFunction(() => document.querySelector(".fanyi-translation") && !document.querySelector(".fanyi-translation[data-loading]"));
    expect(await fresh.evaluate("__state()")).toMatchObject({ active: true });
    await fresh.close();

    const same = await openPage('{ sourceLanguage: "auto", targetLanguage: "zh-TW" }');
    await same.evaluate("document.documentElement.lang = 'zh-TW'; window.__detected = 'zh'; __toggle()");
    await same.waitForFunction("document.querySelector('.fanyi-notice')");
    expect(await same.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(0);
    await same.close();
  });

  it("falls back to the declared language when the text is too little to tell", async () => {
    const fresh = await openPage('{ sourceLanguage: "auto", targetLanguage: "zh-CN" }');
    await fresh.evaluate("document.documentElement.lang = 'zh-CN'; window.__detected = 'en'; window.__detectReliable = false; __toggle()");
    await fresh.waitForFunction("document.querySelector('.fanyi-notice')");
    expect(await fresh.evaluate("document.querySelector('.fanyi-notice').textContent")).toBe("页面语言与目标语言相同，无需翻译");
    expect(await fresh.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(0);
    await fresh.close();
  });
});

describe("unchanged translation results", () => {
  it.each([
    ["sentence boundaries", "第一句话在这里。".repeat(300) + "最后一句。"],
    ["hard cuts", "连续的中文文本".repeat(320)],
  ])("hides unchanged paragraphs and titles split at %s", async (_boundary, source) => {
    const pieces = splitText(source, 2000);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).not.toBe(source);
    const fresh = await openPage('{ sourceLanguage: "auto", targetLanguage: "zh-CN", detectSameLanguage: false, sentenceBreaks: true }');
    await fresh.evaluate(`document.querySelector('.site').innerHTML = ${JSON.stringify(`<p id="unchanged">${source}</p><p id="changed">This paragraph needs translation.</p>`)}; document.title = ${JSON.stringify(source)}; window.__unchanged = ${JSON.stringify(pieces)}`);

    await fresh.evaluate("__toggleAsync()");
    await fresh.waitForFunction("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length === 5 && !document.querySelector('.fanyi-translation[data-loading]')");
    expect(await fresh.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(1);
    expect(await fresh.evaluate("document.getElementById('unchanged').textContent")).toBe(source);
    expect(await fresh.evaluate("__translation('changed').text")).toBe("译文 This paragraph needs translation.");
    expect(await fresh.evaluate("document.title")).toBe(source);
    expect(await fresh.evaluate("__state()")).toMatchObject({ translating: false, translatedCount: 1 });
    await fresh.close();
  });

  it("hides an unchanged split selection but keeps a changed fragment visible", async () => {
    const source = "第一句话在这里。".repeat(20) + "最后一句。";
    const pieces = splitText(source, 100);
    expect(pieces.length).toBeGreaterThan(1);
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "zh-CN", maxCharsPerRequest: 100 }');
    await fresh.evaluate(`document.getElementById('plain').textContent = ${JSON.stringify(source)}; window.__unchanged = ${JSON.stringify(pieces)}; __select('plain')`);
    await fresh.waitForFunction("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length === 2 && (!__popup() || !__popup().loading)");
    expect(await fresh.evaluate("Boolean(__overlay('selection'))")).toBe(false);

    await fresh.evaluate(`window.__sent.length = 0; window.__unchanged = ${JSON.stringify(pieces.slice(0, -1))}; __select('plain')`);
    await fresh.waitForFunction("__popup() && !__popup().loading");
    expect(await fresh.evaluate("__popup().text")).toBe(pieces.map((piece, index) => index === pieces.length - 1 ? `译文 ${piece}` : piece).join(" "));
    expect(await fresh.evaluate("__popup().visible")).toBe(true);
    await fresh.close();
  });

  it("skips target-language paragraphs inside a mixed page before sending a request", async () => {
    const targetText = "这是一段已经是中文的正文。";
    const foreignText = "This paragraph still needs translation.";
    const fresh = await openPage('{ sourceLanguage: "auto", targetLanguage: "zh-CN", translateTitle: false }');
    const content = `<p id="target-text">${targetText}</p><p id="foreign-text">${foreignText}</p>`;
    const detections = { [`${targetText} ${foreignText}`]: "en", [targetText]: "zh", [foreignText]: "en" };
    await fresh.evaluate(`document.querySelector('.site').innerHTML = ${JSON.stringify(content)}; window.__detectedByText = ${JSON.stringify(detections)}; window.__sent.length = 0`);

    await fresh.evaluate("__toggleAsync()");
    await fresh.waitForFunction(() => document.querySelectorAll("[data-fanyi-processed]").length === 2 && !document.querySelector(".fanyi-translation[data-loading]"));
    const requested = await fresh.evaluate<string[]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').flatMap((m) => m.texts)");
    expect(requested).toEqual([foreignText]);
    expect(await fresh.evaluate("Boolean(__translation('target-text'))")).toBe(false);
    expect(await fresh.evaluate("__translation('foreign-text').text")).toBe(`译文 ${foreignText}`);
    await fresh.close();
  });

  it("does not request or render numeric-only page content", async () => {
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await fresh.evaluate("document.querySelector('.site').innerHTML = '<p id=\"number\">12,345.67%</p>'; document.title = '2026'; window.__sent.length = 0");

    await fresh.evaluate("__toggleAsync()");
    expect(await fresh.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length")).toBe(0);
    expect(await fresh.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(0);
    expect(await fresh.evaluate("document.title")).toBe("2026");
    await fresh.close();
  });

  it("removes unchanged paragraph and title results after a provider responds", async () => {
    const paragraph = "Keep this paragraph exactly as written.";
    const title = "Keep this title";
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await fresh.evaluate(`document.querySelector('.site').innerHTML = ${JSON.stringify(`<p id="unchanged">${paragraph}</p>`)}; document.title = ${JSON.stringify(title)}; window.__unchanged = ${JSON.stringify([paragraph, title])}; window.__sent.length = 0`);

    await fresh.evaluate("__toggleAsync()");
    await fresh.waitForFunction("window.__sent.filter((message) => message.type === 'TRANSLATE_TEXTS').length === 2 && !document.querySelector('.fanyi-translation[data-loading]')");
    expect(await fresh.evaluate("document.querySelectorAll('.fanyi-translation').length")).toBe(0);
    expect(await fresh.evaluate("document.title")).toBe(title);
    expect(await fresh.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: 0 });
    await fresh.close();
  });
});

describe("in-place translation in a real page", () => {
  const openInPlace = async (html: string) => {
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "en", translationStyle: "in-place", detectSameLanguage: false, translateFullPage: true }');
    await fresh.locator(".site").evaluate((element, html) => { element.innerHTML = html; }, html);
    return fresh;
  };
  const finished = (fresh: Page) => expect.poll(() => fresh.evaluate("__state()")).toMatchObject({ active: true, translating: false });

  it("replaces only text, preserving whitespace, links, controls, styles and node identity on restore", async () => {
    const html = '<p id="copy" style="font: italic 700 20px/32px Georgia; color: rgb(12, 34, 56)">  Read <a id="link" href="#guide">the guide</a>\n then continue. <img id="image" width="12" height="12"><button id="control">Keep button</button><code>Keep code</code><span hidden>Keep hidden</span><span style="display: contents">Visible contents</span> 123 </p>';
    const fresh = await openInPlace(html);
    const original = await fresh.locator(".site").innerHTML();
    await fresh.evaluate("window.__nodes = [...document.querySelector('#copy').childNodes]; window.__clicks = 0; document.querySelector('#link').addEventListener('click', e => { e.preventDefault(); window.__clicks++; }); __updateSettings({ fontScale: 120, sentenceBreaks: true, translationFirst: true })");
    const properties = [...TEXT_PROPERTIES, "font-size", "display", "margin-top", "padding-top"];
    const style = () => fresh.locator("#copy").evaluate((element, properties) => properties.map((property) => getComputedStyle(element).getPropertyValue(property)), properties);
    const before = await style();
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);

    expect(await fresh.locator("#copy").evaluate((element) => element.firstChild?.textContent)).toBe("  译文 Read ");
    expect(await fresh.locator("#link").textContent()).toBe("译文 the guide");
    expect(await fresh.locator("#copy").evaluate((element) => element.childNodes[2].textContent)).toBe("\n 译文 then continue. ");
    expect(await fresh.locator("#control").textContent()).toBe("Keep button");
    expect(await fresh.locator("#copy code").textContent()).toBe("Keep code");
    expect(await fresh.locator("#copy [hidden]").textContent()).toBe("Keep hidden");
    expect(await fresh.locator("#copy span").last().textContent()).toBe("译文 Visible contents");
    expect(await fresh.locator("#image").isVisible()).toBe(true);
    expect(await style()).toEqual(before);
    expect(await fresh.locator(".fanyi-translation").count()).toBe(0);
    expect(await fresh.title()).toBe("译文 Hello world");
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 1 });
    await fresh.locator("#link").click();
    expect(await fresh.evaluate("window.__clicks")).toBe(1);
    expect(await fresh.evaluate("window.__nodes.every((node, i) => document.querySelector('#copy').childNodes[i] === node)")).toBe(true);
    expect(await fresh.evaluate("window.__sent.filter(m => m.type === 'TRANSLATE_TEXTS').flatMap(m => m.texts)")).toEqual(["Hello world", "Read", "the guide", "then continue.", "Visible contents"]);

    await fresh.evaluate("__toggleAsync()");
    expect(await fresh.locator(".site").innerHTML()).toBe(original);
    expect(await fresh.title()).toBe("Hello world");
    await fresh.locator("#link").click();
    expect(await fresh.evaluate("window.__clicks")).toBe(2);
    expect(await fresh.evaluate("__state()")).toMatchObject({ active: false, translatedCount: 0 });
    await fresh.close();
  });

  it("uses the original flex, grid and table layout without adding translation blocks", async () => {
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "en", translationStyle: "in-place", translateFullPage: true }');
    await fresh.addStyleTag({ content: "#flex, #grid, #cell { line-height: 32px; }" });
    const layout = () => fresh.evaluate(() => ["flex", "grid", "cell", "height"].map((id) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`missing ${id}`);
      return { children: element.children.length, display: getComputedStyle(element).display, height: element.getBoundingClientRect().height };
    }));
    const before = await layout();
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);
    expect(await layout()).toEqual(before);
    expect(await fresh.locator("#flex > span").allTextContents()).toEqual(["译文 Flex heading title", "译文 badge"]);
    expect(await fresh.locator("#grid > span").allTextContents()).toEqual(["译文 First column text", "译文 Second column text"]);
    expect(await fresh.locator("#cell").textContent()).toBe("译文 Table cell text");
    expect(await fresh.locator(".fanyi-translation").count()).toBe(0);
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: IDS.length });
    await fresh.close();
  });

  it("switches between in-place and all bilingual styles without translating the translation", async () => {
    const fresh = await openInPlace('<p id="copy">Read <a href="#">the guide</a>.</p>');
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);
    for (const style of ["soft", "underline", "card"]) {
      await fresh.evaluate((style) => chrome.storage.local.set({ translationStyle: style }), style);
      await fresh.waitForFunction(() => document.querySelector("#copy .fanyi-translation:not([data-loading])"));
      expect(await fresh.locator("#copy a").textContent()).toBe("the guide");
      expect(await fresh.locator("#copy .fanyi-translation").textContent()).toBe("译文 Read the guide.");
      expect(await fresh.title()).toBe("译文 Hello world | Hello world");
      await fresh.evaluate("__updateSettings({ translationStyle: 'in-place' })");
      await finished(fresh);
      expect(await fresh.locator("#copy").textContent()).toBe("译文 Read 译文 the guide.");
      expect(await fresh.locator(".fanyi-translation").count()).toBe(0);
      expect(await fresh.title()).toBe("译文 Hello world");
    }
    expect(await fresh.evaluate("window.__sent.filter(m => m.type === 'TRANSLATE_TEXTS').flatMap(m => m.texts).some(text => text.includes('译文'))")).toBe(false);
    await fresh.close();
  });

  it("leaves originals visible while loading or failed, then retries in place", async () => {
    const fresh = await openInPlace('<p id="copy">Read the guide.</p>');
    await fresh.evaluate("window.__holdRequests = true; __toggleAsync()");
    await fresh.waitForFunction("window.__pending.length === 2");
    expect(await fresh.locator("#copy").evaluate((element) => element.firstChild?.textContent)).toBe("Read the guide.");
    await fresh.evaluate("window.__pending.splice(0).forEach(request => request.reject())");
    await fresh.waitForFunction(() => document.querySelector(".fanyi-retry"));
    expect(await fresh.locator("#copy").evaluate((element) => element.firstChild?.textContent)).toBe("Read the guide.");
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 0 });
    await fresh.evaluate("window.__holdRequests = false");
    await fresh.locator(".fanyi-retry").click();
    await fresh.waitForFunction(() => document.querySelector("#copy")?.textContent === "译文 Read the guide.");
    expect(await fresh.locator(".fanyi-translation").count()).toBe(0);
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 1 });
    await fresh.close();
  });

  it("discards pending results after cancellation and does not overwrite page-owned updates", async () => {
    const fresh = await openInPlace('<p id="copy">Read the guide.</p>');
    await fresh.evaluate("window.__holdRequests = true; __toggleAsync()");
    await fresh.waitForFunction("window.__pending.length === 2");
    await fresh.evaluate("__toggleAsync()");
    await fresh.evaluate("window.__pending.splice(0).forEach(request => request.resolve())");
    expect(await fresh.locator("#copy").textContent()).toBe("Read the guide.");
    expect(await fresh.evaluate("window.__cancelled")).toBe(2);
    await fresh.evaluate("__toggleAsync()");
    await fresh.waitForFunction("window.__pending.length === 2");
    await fresh.evaluate("document.querySelector('#copy').firstChild.data = 'Updated by the website.'; window.__pending.splice(0).forEach(request => request.resolve())");
    await finished(fresh);
    expect(await fresh.locator("#copy").textContent()).toBe("Updated by the website.");
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 0 });
    await fresh.close();
  });

  it("translates newly inserted paragraphs and only restores text still owned by the extension", async () => {
    const fresh = await openInPlace('<p id="copy">Read the guide.</p><p id="changed">Keep up with the news.</p>');
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);
    await fresh.evaluate("document.querySelector('.site').insertAdjacentHTML('beforeend', '<p id=added>New article text.</p>')");
    await fresh.waitForFunction(() => document.querySelector("#added")?.textContent === "译文 New article text.");
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 3 });
    await fresh.evaluate("document.querySelector('#changed').firstChild.data = 'Live website update.'; document.title = 'New website title'; __toggleAsync()");
    expect(await fresh.locator("#copy").textContent()).toBe("Read the guide.");
    expect(await fresh.locator("#changed").textContent()).toBe("Live website update.");
    expect(await fresh.locator("#added").textContent()).toBe("New article text.");
    expect(await fresh.title()).toBe("New website title");
    await fresh.close();
  });

  it("cancels pending in-place work when switching back to bilingual display", async () => {
    const fresh = await openInPlace('<p id="copy">Read the guide.</p>');
    await fresh.evaluate("window.__holdRequests = true; __toggleAsync()");
    await fresh.waitForFunction("window.__pending.length === 2");
    await fresh.evaluate("__updateSettings({ translationStyle: 'soft' })");
    await fresh.waitForFunction("window.__pending.length === 4");
    expect(await fresh.evaluate("window.__cancelled")).toBe(2);
    await fresh.evaluate("window.__pending.splice(0).forEach(request => request.resolve())");
    await finished(fresh);
    expect(await fresh.locator("#copy").evaluate((element) => element.firstChild?.textContent)).toBe("Read the guide.");
    expect(await fresh.locator("#copy .fanyi-translation").textContent()).toBe("译文 Read the guide.");
    expect(await fresh.title()).toBe("译文 Hello world | Hello world");
    await fresh.close();
  });

  it("defers in-place translation below the fold until it is near the viewport", async () => {
    const fresh = await openInPlace('<p id="copy">Read the guide.</p><div style="height: 2500px"></div><p id="deferred">The next chapter.</p>');
    await fresh.evaluate("__updateSettings({ translateFullPage: false, eagerCharacters: 15 })");
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);
    expect(await fresh.locator("#copy").textContent()).toBe("译文 Read the guide.");
    expect(await fresh.locator("#deferred").textContent()).toBe("The next chapter.");
    await fresh.locator("#deferred").scrollIntoViewIfNeeded();
    await fresh.waitForFunction(() => document.querySelector("#deferred")?.textContent === "译文 The next chapter.");
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 2 });
    await fresh.close();
  });

  it("bounds detection concurrency and request sizes even with many nested text fragments", async () => {
    const fresh = await openInPlace(`<p id="copy"><span>${Array.from({ length: 25 }, (_, index) => `<em>Word ${index} </em>`).join("")}</span></p>`);
    await fresh.evaluate("window.__detectDelay = 10; window.__detected = 'de'; window.__maxDetect = 0; let detecting = 0; const detect = chrome.i18n.detectLanguage; chrome.i18n.detectLanguage = async text => { window.__maxDetect = Math.max(window.__maxDetect, ++detecting); try { return await detect(text); } finally { detecting--; } }; __updateSettings({ sourceLanguage: 'auto', detectSameLanguage: true, translateTitle: false, maxParagraphsPerRequest: 2, maxCharsPerRequest: 100 })");
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);
    expect(await fresh.evaluate("window.__maxDetect")).toBe(2);
    expect(await fresh.locator("#copy em").allTextContents()).toEqual(Array.from({ length: 25 }, (_, index) => `译文 Word ${index} `));
    const requests = await fresh.evaluate<string[][]>("window.__sent.filter(m => m.type === 'TRANSLATE_TEXTS').map(m => m.texts)");
    expect(requests.flat()).toHaveLength(25);
    expect(requests.every((texts) => texts.length <= 2 && texts.join("").length <= 100)).toBe(true);
    await fresh.close();
  });

  it("keeps unchanged long text, numbers and target-language text intact and renders translations as plain text", async () => {
    const long = "第一句话在这里。".repeat(30);
    const fresh = await openInPlace(`<p id="echo">${long}</p><p id="number">12345</p><p id="target">Already in English.</p><p id="copy">A foreign sentence.</p>`);
    await fresh.evaluate((unchanged) => {
      Object.assign(window, { __unchanged: unchanged, __detectedByText: { "Already in English.": "en" }, __detected: "de" });
    }, splitText(long, 100));
    await fresh.evaluate("fixedTranslations['A foreign sentence.'] = '<img src=x onerror=alert(1)>translated'; __updateSettings({ sourceLanguage: 'auto', detectSameLanguage: true, maxCharsPerRequest: 100 })");
    await fresh.evaluate("__toggleAsync()");
    await finished(fresh);
    expect(await fresh.locator("#echo").textContent()).toBe(long);
    expect(await fresh.locator("#number").textContent()).toBe("12345");
    expect(await fresh.locator("#target").textContent()).toBe("Already in English.");
    expect(await fresh.locator("#copy").textContent()).toBe("<img src=x onerror=alert(1)>translated");
    expect(await fresh.locator("#copy img").count()).toBe(0);
    expect(await fresh.evaluate("__state()")).toMatchObject({ translatedCount: 1 });
    const requests = await fresh.evaluate<string[][]>("window.__sent.filter(m => m.type === 'TRANSLATE_TEXTS').map(m => m.texts)");
    expect(requests.flat()).not.toContain("12345");
    expect(requests.flat()).not.toContain("Already in English.");
    expect(requests.every((texts) => texts.length <= 4 && texts.join("").length <= 100)).toBe(true);
    await fresh.close();
  });
});

describe("restart after a settings write", () => {
  it("reads the settings that were just saved instead of the ones it had cached", async () => {
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await fresh.evaluate("__toggle()");
    await fresh.waitForFunction(() => document.querySelector(".fanyi-translation") && !document.querySelector(".fanyi-translation[data-loading]"));

    // 改存储但不通知内容脚本，模拟消息比 storage 变更回调先到
    await fresh.evaluate("window.__sent.length = 0; Object.assign(__stored(), { targetLanguage: 'ja' }); __restart()");
    await fresh.waitForFunction("window.__sent.some((m) => m.type === 'TRANSLATE_TEXTS')");
    const targets = await fresh.evaluate<string[]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').map((m) => m.targetLanguage)");
    expect(targets.length).toBeGreaterThan(0);
    expect([...new Set(targets)]).toEqual(["ja"]);
    await fresh.close();
  });
});

describe("text-heavy pages", () => {
  it("keeps a failure pause through idle continuation and resumes everything from one retry", async () => {
    const heavy = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await heavy.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 1100; index += 1) {
        const paragraph = document.createElement("p");
        paragraph.textContent = `Paragraph number ${index} of a very long article.`;
        fragment.append(paragraph);
      }
      document.querySelector(".site")?.append(fragment);
    });
    await heavy.evaluate("window.__failAll = true; __updateSettings({ translateFullPage: true, translateTitle: false })");
    await heavy.evaluate("__toggle()");
    await heavy.waitForFunction(() => document.querySelectorAll(".fanyi-translation[data-error]").length >= 12 && !document.querySelector(".fanyi-translation[data-loading]"));
    // 等空闲补采把后面的扫描块也排进队列
    await heavy.waitForFunction("document.querySelectorAll('[data-fanyi-processed]').length >= 1100", undefined, { timeout: 15000 });
    await heavy.waitForTimeout(500);
    const requests = () => heavy.evaluate<number>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length");
    expect(await requests()).toBeLessThanOrEqual(5);
    expect(await heavy.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: 0 });

    await heavy.evaluate("window.__failAll = false; document.querySelector('.fanyi-translation[data-error] a.fanyi-retry').click()");
    // 重试成功后暂停解除，队列里全部段落翻完；只有最初失败的那几批还带着错误和重试链接
    await heavy.waitForFunction((total) => !document.querySelector(".fanyi-translation[data-loading]") && document.querySelectorAll(".fanyi-translation").length === total, IDS.length + 1100, { timeout: 15000 });
    const errors = await heavy.evaluate<number>("document.querySelectorAll('.fanyi-translation[data-error]').length");
    expect(errors).toBeLessThan(20);
    expect(await heavy.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: IDS.length + 1100 - errors });
    await heavy.close();
  }, 40000);

  it("keeps collecting past the per-scan block limit until the whole page is translated", async () => {
    const heavy = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await heavy.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 1100; index += 1) {
        const paragraph = document.createElement("p");
        paragraph.textContent = `Paragraph number ${index} of a very long article.`;
        fragment.append(paragraph);
      }
      document.querySelector(".site")?.append(fragment);
    });
    await heavy.evaluate("window.__scans = 0; const native = document.querySelectorAll.bind(document); document.querySelectorAll = (selector) => { if (String(selector).startsWith('p, li')) window.__scans += 1; return native(selector); }");
    await heavy.evaluate("__updateSettings({ translateFullPage: true, translateTitle: false })");
    await heavy.evaluate("__toggle()");
    await heavy.waitForFunction((count) => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === count && !document.querySelector(".fanyi-translation[data-loading]"), IDS.length + 1100, { timeout: 15000 });
    expect(await heavy.evaluate("__state()")).toMatchObject({ active: true, translating: false, translatedCount: IDS.length + 1100 });
    expect(await heavy.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').every((m) => m.texts.length <= 4)")).toBe(true);
    // 超过 1000 块时从游标接着采，不再整页重扫
    expect(await heavy.evaluate("window.__scans")).toBe(1);
    await heavy.close();
  }, 20000);
});

describe("page load with the translation switch", () => {
  it("starts translating on its own only when the switch is on, whatever the scope option says", async () => {
    const auto = await openPage('{ sourceLanguage: "de", targetLanguage: "en", pageTranslationEnabled: true, translateFullPage: true }');
    await auto.waitForFunction(() => document.querySelector(".fanyi-translation") && !document.querySelector(".fanyi-translation[data-loading]"));
    expect(await auto.evaluate("__state()")).toMatchObject({ active: true, translatedCount: IDS.length });
    expect(await auto.evaluate("Boolean(__translation('far'))")).toBe(true);
    await auto.close();

    const eager = await openPage('{ sourceLanguage: "de", targetLanguage: "en", pageTranslationEnabled: true }');
    await eager.waitForFunction(() => document.querySelector(".fanyi-translation") && !document.querySelector(".fanyi-translation[data-loading]"));
    expect(await eager.evaluate("__state()")).toMatchObject({ active: true });
    await eager.close();

    // 开关关着时，“一次性翻译到页面底部”只决定范围，不会自己开始翻译
    const scopeOnly = await openPage('{ sourceLanguage: "de", targetLanguage: "en", translateFullPage: true }');
    await scopeOnly.waitForTimeout(500);
    expect(await scopeOnly.evaluate("__state()")).toMatchObject({ active: false, translatedCount: 0 });
    await scopeOnly.close();

    const manual = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await manual.waitForTimeout(500);
    expect(await manual.evaluate("__state()")).toMatchObject({ active: false, translatedCount: 0 });
    await manual.close();
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

  it("splits a long selection through the same request limit", async () => {
    const originalLong = FIXTURE.match(/<p id="long">([^<]+)<\/p>/)?.[1] ?? "";
    await page.evaluate("window.__sent.length = 0; __updateSettings({ maxCharsPerRequest: 100 })");
    await page.evaluate("__select('long')");
    const popup = await settledPopup();
    expect(popup.text.replace(/译文 /g, "")).toBe(originalLong);
    const requests = await page.evaluate<string[][]>("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').map((m) => m.texts)");
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((texts) => texts.join("").length <= 100)).toBe(true);
    await page.evaluate("__updateSettings({ maxCharsPerRequest: 2000 })");
  });

  it("cancels the pending request when the popup is closed", async () => {
    await page.evaluate("window.__holdRequests = true; window.__cancelled = 0; __select('plain')");
    await page.waitForFunction("window.__pending.length === 1 && __overlay('selection')");
    await page.evaluate("__overlay('selection').querySelector('.close').click()");
    expect(await page.evaluate("window.__cancelled")).toBe(1);
    expect(await page.evaluate("Boolean(__overlay('selection'))")).toBe(false);

    await page.evaluate("__select('next')");
    await page.waitForFunction("window.__pending.length === 2 && __overlay('selection')");
    await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    expect(await page.evaluate("window.__cancelled")).toBe(2);
    expect(await page.evaluate("Boolean(__overlay('selection'))")).toBe(false);
    await page.evaluate("window.__holdRequests = false; window.__pending.splice(0).forEach((p) => p.resolve())");
  });

  it("does not open or request for a selection already in the target language", async () => {
    const fresh = await openPage('{ sourceLanguage: "auto", targetLanguage: "en" }');
    await fresh.evaluate("window.__sent.length = 0; __select('plain')");
    await fresh.waitForTimeout(400);
    expect(await fresh.evaluate("Boolean(__overlay('selection'))")).toBe(false);
    expect(await fresh.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length")).toBe(0);
    await fresh.close();
  });

  it("closes the selection card when the provider returns the source unchanged", async () => {
    const source = "A plain paragraph in the host page.";
    const fresh = await openPage('{ sourceLanguage: "de", targetLanguage: "en" }');
    await fresh.evaluate(`window.__unchanged = [${JSON.stringify(source)}]; window.__sent.length = 0; window.__select('plain')`);
    await fresh.waitForFunction("window.__sent.some((message) => message.type === 'TRANSLATE_TEXTS')");
    await fresh.waitForFunction("!window.__overlay('selection')");
    expect(await fresh.evaluate("window.__sent.filter((m) => m.type === 'TRANSLATE_TEXTS').length")).toBe(1);
    await fresh.close();
  });

  it("stays quiet when selection translation is disabled", async () => {
    await page.evaluate("__updateSettings({ selectionEnabled: false })");
    await page.evaluate("__select('plain')");
    await page.waitForTimeout(400);
    expect(await page.evaluate("Boolean(__overlay('selection') || __overlay('trigger'))")).toBe(false);
  });
});
