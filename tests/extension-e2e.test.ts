import { execFileSync } from "node:child_process";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageStateResponse } from "../src/messages";

// 后台 Service Worker 发出的请求默认不经过 Playwright 路由，开启实验开关后才能拦截 Google 接口
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const root = fileURLToPath(new URL("..", import.meta.url));
const TITLE = "Field notes";
const HEADING = "Reading in the wild";
const LEAD = "Language shapes how we see the world.";
const BODY = "A good translation should feel like it was always there.";
const INNER = "Inner paragraph inside a quote wrapper.";
const SIDEBAR = "Sidebar paragraph text.";
const FAR = "A paragraph far below the fold.";
const MASTHEAD = "Masthead text in the header.";
const FRESH_FIRST = "A paragraph added after the first run.";
const FRESH_SECOND = "Another paragraph added after the first run.";

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body style="margin: 0; padding: 24px; font: 16px/1.5 Georgia, serif">
<header><p id="masthead">${MASTHEAD}</p></header>
<nav><a id="navlink" href="#">Navigation link text.</a></nav>
<main>
  <h1 id="heading">${HEADING}</h1>
  <p id="lead">${LEAD}</p>
  <p id="body">${BODY}</p>
  <p id="hidden" hidden>Hidden paragraph must stay untouched.</p>
  <p id="invisible" style="visibility: hidden">Invisible paragraph must stay untouched.</p>
  <p id="transparent" style="opacity: 0">Transparent paragraph must stay untouched.</p>
  <p id="decorative" aria-hidden="true">Decorative paragraph must stay untouched.</p>
  <p id="editable" contenteditable="true">Editable paragraph must stay untouched.</p>
  <pre id="snippet">const answer = 42;</pre>
  <blockquote id="wrapper"><p id="inner">${INNER}</p></blockquote>
  <p id="crowded"><b>one</b> <b>two</b> <b>three</b> <b>four</b> <b>five</b> <b>six</b> <b>seven</b> <b>eight</b> <b>nine</b> <b>ten</b> <b>eleven</b> <b>twelve</b> <b>thirteen</b></p>
  <p id="symbols">••• — •••</p>
  <p id="short">A</p>
  <textarea id="field">Text inside a form field.</textarea>
  <button id="cta">Call to action</button>
  <div style="height: 2000px"></div>
  <p id="far">${FAR}</p>
</main>
<aside><p id="sidebar">${SIDEBAR}</p></aside>
<footer><p id="legal">Footer legal text.</p></footer>
</body></html>`;

const CHINESE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>中文页面</title></head><body><p id="cn">这是一段已经是中文的正文。</p></body></html>`;
// 繁体正文：语言检测只会给出笼统的 zh，简繁之分只存在于页面声明里
const TRADITIONAL_LEAD = "閱讀不同語言的文章能夠幫助我們理解世界的另一面。";
const TRADITIONAL_BODY = "良好的翻譯應該保留原文的含義，同時讓讀者感覺不到轉換的痕跡，這需要譯者對兩種語言都有足夠的體會。";
const TRADITIONAL = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>繁體頁面</title></head><body><p id="tw-lead">${TRADITIONAL_LEAD}</p><p id="tw-body">${TRADITIONAL_BODY}</p></body></html>`;
// 页面声明的是英文，正文却是繁体中文：检测只会说 zh，简繁只能从正文的专用字看出来
const DECLARED_EN_TRADITIONAL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mail</title></head><body><p id="tw-mail">${TRADITIONAL_LEAD}${TRADITIONAL_BODY}</p></body></html>`;
// 很长的中文配一整段英文：英文占比被稀释到 7% 左右，但它仍是三句完整正文
const LONG_CHINESE = "阅读不同语言的文章能够帮助我们理解世界的另一面。良好的翻译应该保留原文的含义，同时让读者感觉不到转换的痕迹，这需要译者对两种语言都有足够的体会。".repeat(15);
const LONG_ENGLISH = "Reading in another language can help us understand the world. A good translation preserves the meaning of the original text and makes difficult ideas easier to understand. Please read this message carefully and reply when you have finished reviewing the information.";
const FAINT_ENGLISH = "Please reply before Friday.";
const longPage = (english: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>长文</title></head><body><p id="long-cn">${LONG_CHINESE}</p><p id="long-en">${english}</p></body></html>`;
// 以中文为主但仍有整段英文：检测会同时报出两种语言，英文那段正是要翻译的
const MIXED_CHINESE = "这是一段中文说明，用来占据页面的大部分篇幅。";
const MIXED_CHINESE_MORE = "良好的翻译应该保留原文的含义，同时让读者感觉不到转换的痕迹，这需要译者对两种语言都有足够的体会。";
const MIXED_ENGLISH = "The report argues that automation will reshape entry level work across many industries, and that companies should invest in retraining long before the pressure becomes visible in hiring numbers.";
const MIXED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>混合页面</title></head><body><p id="mixed-cn">${MIXED_CHINESE}</p><p id="mixed-cn2">${MIXED_CHINESE_MORE}</p><p id="mixed-en">${MIXED_ENGLISH}</p></body></html>`;
// 邮箱一类 Web 应用把界面语言写在 <html lang> 上，正文却是另一种语言
const CHINESE_SHELL = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>收件箱</title></head><body><nav><a href="#">收件箱</a></nav><p id="mail-lead">${LEAD}</p><p id="mail-body">${BODY}</p><p id="mail-inner">${INNER}</p></body></html>`;

interface DomNode {
  nodeType: number;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

interface AiRequest {
  authorization: string;
  model: string;
  prompt: string;
}

let server: http.Server;
let origin: string;
let context: BrowserContext;
let worker: Worker;
let page: Page;
const googleRequests: string[][] = [];
const aiRequests: AiRequest[] = [];
let aiRejects = false;

function startServer(): Promise<void> {
  server = http.createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    if (request.url === "/v1/chat/completions") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const { model, messages } = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
        const prompt = messages[1].content;
        aiRequests.push({ authorization: request.headers.authorization ?? "", model, prompt });
        response.setHeader("content-type", "application/json");
        if (aiRejects) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: { message: "invalid api key" } }));
          return;
        }
        const texts = prompt.slice(prompt.indexOf(": ") + 2).split("\n\n%%\n\n");
        response.end(JSON.stringify({ choices: [{ message: { content: texts.map((text) => `AI ${text}`).join("\n\n%%\n\n") } }] }));
      });
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    const pages: Record<string, string> = { "/zh": CHINESE, "/zh-shell": CHINESE_SHELL, "/zh-tw": TRADITIONAL, "/mixed": MIXED, "/en-tw": DECLARED_EN_TRADITIONAL, "/long-mixed": longPage(LONG_ENGLISH), "/long-faint": longPage(FAINT_ENGLISH) };
    response.end(pages[request.url ?? ""] ?? ARTICLE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a port");
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

// 快捷键和右键菜单都是后台向当前标签页发这条消息，测试从同一位置发起
function askActiveTab(type: "TOGGLE_PAGE" | "GET_PAGE_STATE"): Promise<PageStateResponse> {
  return worker.evaluate(async (type) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");
    const state: PageStateResponse = await chrome.tabs.sendMessage(tab.id, { type });
    return state;
  }, type);
}

function badgeText(): Promise<string> {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.action.getBadgeText({ tabId: tab?.id });
  });
}

const translationOf = (id: string): Promise<string | null> => page.evaluate((id) => document.querySelector(`#${id} .fanyi-translation, #${id} + .fanyi-translation`)?.textContent ?? null, id);
const settled = (count: number): Promise<unknown> => page.waitForFunction((count) => document.querySelectorAll(".fanyi-translation").length === count && !document.querySelector(".fanyi-translation[data-loading]"), count, { timeout: 15000 });
const noticeText = (): Promise<string | null> => page.evaluate(() => document.querySelector(".fanyi-notice")?.textContent ?? null);

async function openPopup(): Promise<Page> {
  // 弹窗以后台标签页打开，这样它眼里的“当前标签页”仍是文章页
  const opened = context.waitForEvent("page");
  await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false }));
  const popup = await opened;
  // 开关从静态的未选中变成已选中，说明弹窗已拿到设置和页面状态
  await popup.waitForFunction(() => document.querySelector<HTMLInputElement>("#selection-enabled")?.checked, undefined, { polling: 100 });
  return popup;
}

async function openOptions(section: string): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#${section}`);
  await options.waitForFunction(() => document.querySelectorAll("#options-target-language option").length > 0);
  return options;
}

async function setOption(options: Page, selector: string, value: string): Promise<void> {
  const field = options.locator(selector);
  await field.fill(value);
  await field.blur();
}

const textOf = (node: DomNode): string => (node.nodeType === 3 ? node.nodeValue : (node.children ?? []).map(textOf).join(""));

function textWithin(node: DomNode, className: string): string | undefined {
  const attributes = node.attributes ?? [];
  const index = attributes.indexOf("class");
  if (index >= 0 && attributes[index + 1].split(" ").includes(className)) return textOf(node);
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = textWithin(child, className);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function selectionCard(): Promise<string | undefined> {
  // 划词卡片在 closed shadow root 里，页面脚本看不到，只有 CDP 能穿透
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-fanyi-root='selection']" });
    if (!nodeId) return undefined;
    const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
    return textWithin(node, "result");
  } finally {
    await cdp.detach();
  }
}

async function selectByMouse(id: string): Promise<void> {
  // 先点一下空白处清掉上次的选区，否则在已选中的文字上按下拖动会变成拖拽文本
  await page.mouse.click(5, 5);
  const box = await page.locator(`#${id}`).boundingBox();
  if (!box) throw new Error(`missing #${id}`);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 4 });
  await page.mouse.up();
}

beforeAll(async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "ignore" });
  await startServer();
  const extension = join(root, "dist");
  // 品牌版 Chrome 已不再接受 --load-extension，扩展只能装进 Playwright 的 Chrome for Testing
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await context.route("https://translate.googleapis.com/**", async (route) => {
    const request = route.request();
    const texts = new URLSearchParams(request.postData() ?? "").getAll("q");
    googleRequests.push(texts);
    const auto = new URL(request.url()).searchParams.get("sl") === "auto";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(texts.map((text) => (auto ? [`译文 ${text}`, "en"] : `译文 ${text}`))) });
  });
  page = await context.newPage();
  await page.goto(`${origin}/article`);
}, 90000);

afterAll(async () => {
  await context?.close();
  server?.close();
});

describe("the built extension in Chrome", () => {
  it("translates what a reader can see, skips the rest, and restores the page when toggled off", async () => {
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: true, supported: true });
    await settled(6);
    for (const [id, text] of [["heading", HEADING], ["lead", LEAD], ["body", BODY], ["inner", INNER], ["sidebar", SIDEBAR], ["far", FAR]]) {
      expect(await translationOf(id)).toBe(`译文 ${text}`);
    }
    expect(await page.title()).toBe(`译文 ${TITLE} | ${TITLE}`);
    expect(await badgeText()).toBe("ON");
    expect(googleRequests.flat().sort()).toEqual([TITLE, HEADING, LEAD, BODY, INNER, SIDEBAR, FAR].sort());
    expect(await askActiveTab("GET_PAGE_STATE")).toMatchObject({ active: true, translating: false, translatedCount: 6 });

    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: false, translatedCount: 0 });
    expect(await page.evaluate(() => document.querySelectorAll(".fanyi-translation, [data-fanyi-processed]").length)).toBe(0);
    expect(await page.title()).toBe(TITLE);
    expect(await badgeText()).toBe("");
  }, 30000);

  it("serves the next run from the background cache without asking the service again", async () => {
    const requestsBefore = googleRequests.length;
    await askActiveTab("TOGGLE_PAGE");
    await settled(6);
    expect(await translationOf("lead")).toBe(`译文 ${LEAD}`);
    expect(await page.title()).toBe(`译文 ${TITLE} | ${TITLE}`);
    expect(googleRequests.length).toBe(requestsBefore);
    await askActiveTab("TOGGLE_PAGE");
  }, 30000);

  it("requests only the paragraphs that are new and keeps every translation on its own paragraph", async () => {
    // 新段落夹在已缓存的段落之间，同一批请求里既有命中也有未命中，回填时必须按原位置归位
    await page.evaluate(([first, second]) => {
      document.querySelector("#heading")?.insertAdjacentHTML("afterend", `<p id="fresh-first">${first}</p>`);
      document.querySelector("#body")?.insertAdjacentHTML("afterend", `<p id="fresh-second">${second}</p>`);
    }, [FRESH_FIRST, FRESH_SECOND]);
    const requestsBefore = googleRequests.length;
    await askActiveTab("TOGGLE_PAGE");
    await settled(8);
    expect(googleRequests.slice(requestsBefore).flat().sort()).toEqual([FRESH_FIRST, FRESH_SECOND].sort());
    for (const [id, text] of [["heading", HEADING], ["fresh-first", FRESH_FIRST], ["lead", LEAD], ["body", BODY], ["fresh-second", FRESH_SECOND], ["inner", INNER], ["sidebar", SIDEBAR], ["far", FAR]]) {
      expect(await translationOf(id)).toBe(`译文 ${text}`);
    }
    await askActiveTab("TOGGLE_PAGE");
    await page.evaluate(() => document.querySelectorAll("#fresh-first, #fresh-second").forEach((element) => element.remove()));
  }, 30000);

  it("refuses a page that is already in the target language", async () => {
    const requestsBefore = googleRequests.length;
    const chinese = await context.newPage();
    await chinese.goto(`${origin}/zh`);
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: false, translatedCount: 0 });
    await chinese.waitForFunction(() => document.querySelector(".fanyi-notice")?.textContent === "页面语言与目标语言相同，无需翻译");
    expect(await chinese.evaluate(() => document.querySelectorAll(".fanyi-translation").length)).toBe(0);
    expect(googleRequests.length).toBe(requestsBefore);
    await chinese.close();
    await page.bringToFront();
  }, 30000);

  it("translates a page whose interface language is the target language but whose text is not", async () => {
    const mailbox = await context.newPage();
    await mailbox.goto(`${origin}/zh-shell`);
    await mailbox.bringToFront();
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: true, supported: true });
    await mailbox.waitForFunction(() => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === 3, undefined, { timeout: 15000 });
    const translations = await mailbox.evaluate(() => ["mail-lead", "mail-body", "mail-inner"].map((id) => document.querySelector(`#${id} .fanyi-translation, #${id} + .fanyi-translation`)?.textContent ?? null));
    expect(translations).toEqual([`译文 ${LEAD}`, `译文 ${BODY}`, `译文 ${INNER}`]);
    expect(await mailbox.evaluate(() => Boolean(document.querySelector(".fanyi-notice")))).toBe(false);

    await askActiveTab("TOGGLE_PAGE");
    await mailbox.close();
    await page.bringToFront();
  }, 30000);

  it("keeps simplified and traditional Chinese apart although the detector only reports Chinese", async () => {
    const traditional = await context.newPage();
    await traditional.goto(`${origin}/zh-tw`);
    await traditional.bringToFront();
    // 检测只说“中文”，繁体正文翻成简体这件事仍然要做
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: true, supported: true });
    await traditional.waitForFunction(() => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === 2, undefined, { timeout: 15000 });
    expect(await traditional.evaluate(() => document.querySelector("#tw-lead .fanyi-translation, #tw-lead + .fanyi-translation")?.textContent ?? null)).toBe(`译文 ${TRADITIONAL_LEAD}`);
    await askActiveTab("TOGGLE_PAGE");
    await traditional.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);

    // 目标语言换成繁体后，同一页就该被判为无需翻译
    const options = await openOptions("general");
    await options.selectOption("#options-target-language", "zh-TW");
    await traditional.bringToFront();
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: false, translatedCount: 0 });
    await traditional.waitForFunction(() => document.querySelector(".fanyi-notice")?.textContent === "页面语言与目标语言相同，无需翻译");
    expect(await traditional.evaluate(() => document.querySelectorAll(".fanyi-translation").length)).toBe(0);

    await options.bringToFront();
    await options.selectOption("#options-target-language", "zh-CN");
    await options.close();
    await traditional.close();
    await page.bringToFront();
  }, 30000);

  it("translates a page that is mostly in the target language but still carries a foreign paragraph", async () => {
    const mixed = await context.newPage();
    await mixed.goto(`${origin}/mixed`);
    await mixed.bringToFront();
    // 检测把中文排在第一位，但英文那段仍然要翻译，不能整页拒绝
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: true, supported: true });
    await mixed.waitForFunction(() => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === 3, undefined, { timeout: 15000 });
    expect(await mixed.evaluate(() => document.querySelector("#mixed-en .fanyi-translation, #mixed-en + .fanyi-translation")?.textContent ?? null)).toBe(`译文 ${MIXED_ENGLISH}`);
    expect(await mixed.evaluate(() => Boolean(document.querySelector(".fanyi-notice")))).toBe(false);
    await askActiveTab("TOGGLE_PAGE");
    await mixed.close();
    await page.bringToFront();
  }, 30000);

  it("translates traditional text even when the page declares another language", async () => {
    const mail = await context.newPage();
    await mail.goto(`${origin}/en-tw`);
    await mail.bringToFront();
    // 检测只说 zh，声明又是 en，简繁只能从正文的专用字判断
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: true, supported: true });
    await mail.waitForFunction(() => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === 1, undefined, { timeout: 15000 });
    expect(await mail.evaluate(() => document.querySelector("#tw-mail .fanyi-translation, #tw-mail + .fanyi-translation")?.textContent ?? null)).toBe(`译文 ${TRADITIONAL_LEAD}${TRADITIONAL_BODY}`);
    await askActiveTab("TOGGLE_PAGE");
    await mail.close();
    await page.bringToFront();
  }, 30000);

  it("tells a whole foreign paragraph from a few foreign words however long the rest of the page is", async () => {
    // 英文整段只占约 7%，但它是三句完整正文，仍然要翻译
    const mixed = await context.newPage();
    await mixed.goto(`${origin}/long-mixed`);
    await mixed.bringToFront();
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: true, supported: true });
    await mixed.waitForFunction(() => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === 2, undefined, { timeout: 15000 });
    expect(await mixed.evaluate(() => document.querySelector("#long-en .fanyi-translation, #long-en + .fanyi-translation")?.textContent ?? null)).toBe(`译文 ${LONG_ENGLISH}`);
    await askActiveTab("TOGGLE_PAGE");
    await mixed.close();

    // 同一篇中文只带一句英文时仍算零星外语，不该整页重译
    const faint = await context.newPage();
    await faint.goto(`${origin}/long-faint`);
    await faint.bringToFront();
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ active: false, translatedCount: 0 });
    await faint.waitForFunction(() => document.querySelector(".fanyi-notice")?.textContent === "页面语言与目标语言相同，无需翻译");
    expect(await faint.evaluate(() => document.querySelectorAll(".fanyi-translation").length)).toBe(0);
    await faint.close();
    await page.bringToFront();
  }, 30000);

  it("drives page translation from the popup and lets it switch selection translation off and on", async () => {
    const popup = await openPopup();
    expect(await popup.textContent("#translate-page")).toBe("翻译");
    expect(await popup.isEnabled("#translate-page")).toBe(true);
    await popup.click("#translate-page");
    await settled(6);
    // 弹窗保持打开也能看到翻译完成，按钮就地变成关闭入口
    await expect.poll(() => popup.textContent("#translate-page")).toBe("显示原文");
    expect(await popup.getAttribute("#translate-page", "aria-pressed")).toBe("true");
    expect(await popup.isEnabled("#translate-page")).toBe(true);
    expect(await badgeText()).toBe("ON");
    await popup.click("#translate-page");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await expect.poll(() => popup.textContent("#translate-page")).toBe("翻译");
    expect(await badgeText()).toBe("");

    // 从快捷键入口开关时弹窗同样跟着变
    await askActiveTab("TOGGLE_PAGE");
    await expect.poll(() => popup.textContent("#translate-page")).toBe("显示原文");
    await askActiveTab("TOGGLE_PAGE");
    await expect.poll(() => popup.textContent("#translate-page")).toBe("翻译");

    await popup.click("label.selection-row");
    expect(await popup.isChecked("#selection-enabled")).toBe(false);
    await selectByMouse("masthead");
    await page.waitForTimeout(800);
    expect(await selectionCard()).toBeUndefined();

    await popup.click("label.selection-row");
    expect(await popup.isChecked("#selection-enabled")).toBe(true);
    // 页眉不参与网页翻译，划词请求不会命中后台缓存
    await selectByMouse("masthead");
    await expect.poll(selectionCard, { timeout: 10000 }).toBe(`译文 ${MASTHEAD}`);
    expect(googleRequests.at(-1)).toEqual([MASTHEAD]);
    await page.mouse.click(5, 5);
    await expect.poll(selectionCard).toBeUndefined();
    await popup.close();
  }, 30000);

  it("switches the translation service from the popup and keeps every page opened while the switch is on translated", async () => {
    const popup = await openPopup();
    expect(await popup.inputValue("#provider")).toBe("google");
    await popup.click("#translate-page");
    await settled(6);
    await expect.poll(() => popup.textContent("#translate-page")).toBe("显示原文");

    // 开关是全局的，之后打开的网页自己就开始翻译，不用再点一次
    const second = await context.newPage();
    await second.goto(`${origin}/article`);
    await second.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 6 && !document.querySelector(".fanyi-translation[data-loading]"), undefined, { timeout: 15000 });
    expect(await second.evaluate(() => document.querySelector("#lead .fanyi-translation, #lead + .fanyi-translation")?.textContent ?? null)).toBe(`译文 ${LEAD}`);

    // 在任意一个标签页关掉，已经打开的网页都恢复原文
    await second.bringToFront();
    await askActiveTab("TOGGLE_PAGE");
    await second.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await second.close();
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await expect.poll(() => popup.textContent("#translate-page")).toBe("翻译");
    await popup.close();
  }, 30000);

  it("turns the global switch off from a supported page that needs no translation", async () => {
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ enabled: true, active: true });
    await settled(6);
    const chinese = await context.newPage();
    await chinese.goto(`${origin}/zh`);
    await chinese.waitForFunction(() => document.querySelector(".fanyi-notice")?.textContent === "页面语言与目标语言相同，无需翻译");
    await chinese.bringToFront();

    // 这一页因为语言相同没有译文，但全局开关是开的，弹窗照样给出关闭入口
    const popup = await openPopup();
    expect(await popup.textContent("#translate-page")).toBe("显示原文");
    await popup.click("#translate-page");
    await expect.poll(() => popup.textContent("#translate-page")).toBe("翻译");
    expect(await popup.getAttribute("#translate-page", "aria-pressed")).toBe("false");
    await popup.close();
    await chinese.close();
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);

    // 关掉之后新打开的英文页不再自动翻译
    const fresh = await context.newPage();
    await fresh.goto(`${origin}/article`);
    await fresh.waitForTimeout(1000);
    expect(await fresh.evaluate(() => document.querySelectorAll(".fanyi-translation").length)).toBe(0);
    await fresh.close();
    await page.bringToFront();
  }, 30000);

  it("translates a page that needed no translation once the popup picks another target language", async () => {
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ enabled: true, active: true });
    await settled(6);
    const chinese = await context.newPage();
    await chinese.goto(`${origin}/zh`);
    await chinese.waitForFunction(() => document.querySelector(".fanyi-notice")?.textContent === "页面语言与目标语言相同，无需翻译");
    await chinese.bringToFront();
    const popup = await openPopup();

    // 全局开关开着，换一种目标语言后这一页不用刷新就该有译文
    await popup.selectOption("#target-language", "en");
    await chinese.waitForFunction(() => document.querySelectorAll(".fanyi-translation:not([data-loading])").length === 1, undefined, { timeout: 15000 });
    expect(await chinese.evaluate(() => document.querySelector("#cn .fanyi-translation, #cn + .fanyi-translation")?.textContent ?? null)).toBe("译文 这是一段已经是中文的正文。");

    await popup.selectOption("#target-language", "zh-CN");
    await chinese.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    await popup.click("#translate-page");
    await expect.poll(() => popup.textContent("#translate-page")).toBe("翻译");
    await popup.close();
    await chinese.close();
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
  }, 30000);

  it("stays off after being turned off even when translate-to-bottom is on", async () => {
    const options = await openOptions("general");
    await options.click("label.switch-row:has(input[data-setting='translateFullPage'])");
    await expect.poll(() => options.isChecked("input[data-setting='translateFullPage']")).toBe(true);
    await page.bringToFront();

    await askActiveTab("TOGGLE_PAGE");
    await settled(6);
    expect(await askActiveTab("TOGGLE_PAGE")).toMatchObject({ enabled: false, active: false });

    // 明确关掉后，“立即翻译到页面底部”不再把新打开的网页重新打开翻译
    const fresh = await context.newPage();
    await fresh.goto(`${origin}/article`);
    await fresh.waitForTimeout(1000);
    expect(await fresh.evaluate(() => document.querySelectorAll(".fanyi-translation").length)).toBe(0);
    await fresh.close();

    await options.bringToFront();
    await options.click("label.switch-row:has(input[data-setting='translateFullPage'])");
    await expect.poll(() => options.isChecked("input[data-setting='translateFullPage']")).toBe(false);
    await options.close();
    await page.bringToFront();
  }, 30000);

  it("applies options live: a small eager budget defers paragraphs below the fold and excluding the site turns translation off", async () => {
    const options = await openOptions("general");
    await setOption(options, "input[data-setting='eagerCharacters']", "60");
    await page.bringToFront();
    await askActiveTab("TOGGLE_PAGE");
    await settled(4);
    expect(await translationOf("far")).toBeNull();
    expect(await translationOf("sidebar")).toBeNull();
    await page.locator("#far").scrollIntoViewIfNeeded();
    await settled(6);
    expect(await translationOf("far")).toBe(`译文 ${FAR}`);

    await options.bringToFront();
    await options.click("nav button[data-section='sites']");
    await setOption(options, "#excluded-sites", "127.0.0.1");
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
    expect(await askActiveTab("GET_PAGE_STATE")).toMatchObject({ active: false, supported: false });
    expect(await badgeText()).toBe("");

    await options.bringToFront();
    await setOption(options, "#excluded-sites", "");
    await options.click("nav button[data-section='general']");
    await setOption(options, "input[data-setting='eagerCharacters']", "4999");
    await page.bringToFront();
    await expect.poll(async () => (await askActiveTab("GET_PAGE_STATE")).supported).toBe(true);
    await options.close();
    // 站点重新可用后本页跟着开关继续翻译，用例收尾时把开关关掉
    await expect.poll(async () => (await askActiveTab("TOGGLE_PAGE")).enabled).toBe(false);
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === 0);
  }, 30000);

  it("uses a self-hosted AI service configured on the options page and recovers from a rejected request through the retry link", async () => {
    const options = await openOptions("service");
    await options.click("label.option:has(input[value='openai'])");
    await setOption(options, "#api-base-url", `${origin}/v1`);
    await setOption(options, "#api-key", "local-test-key");
    await setOption(options, "#api-model", "test-model");
    await options.close();

    aiRejects = true;
    await page.bringToFront();
    await askActiveTab("TOGGLE_PAGE");
    await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation[data-error]").length === 6 && !document.querySelector(".fanyi-translation[data-loading]"), undefined, { timeout: 15000 });
    expect(await translationOf("lead")).toBe("翻译失败：invalid api key 重试");
    await expect.poll(noticeText).toBe("6 个段落翻译失败：invalid api key");
    expect(aiRequests.at(-1)).toMatchObject({ authorization: "Bearer local-test-key", model: "test-model" });
    expect(aiRequests.some(({ prompt }) => prompt.includes(LEAD))).toBe(true);

    aiRejects = false;
    const requestsBefore = aiRequests.length;
    await page.click("#lead .fanyi-retry, #lead + .fanyi-translation .fanyi-retry");
    await expect.poll(() => translationOf("lead"), { timeout: 10000 }).toBe(`AI ${LEAD}`);
    expect(await translationOf("body")).toBe("翻译失败：invalid api key 重试");
    expect(aiRequests.length).toBe(requestsBefore + 1);
    expect(aiRequests.at(-1)?.prompt).toBe(`Translate to Simplified Chinese: ${LEAD}`);
    await askActiveTab("TOGGLE_PAGE");
  }, 30000);
});
