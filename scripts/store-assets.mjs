import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// 后台 Service Worker 发出的请求默认不经过 Playwright 路由，开启实验开关后才能拦截 Google 接口
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const OUT = "store";
const TITLE = "Why slow reading still matters";
const PARAGRAPHS = [
  ["Most of what we read online is skimmed. We scroll, we scan, we move on. Yet the pieces that change how we think are almost always the ones we read slowly, sentence by sentence, giving each idea room to settle.", "我们在网上读到的大部分内容都是一扫而过：滚动、扫视、然后离开。然而真正改变我们思考方式的文章，几乎总是那些被我们逐句慢读、让每个想法都有时间沉淀下来的文字。"],
  ["Slow reading is not about speed at all. It is about attention. When you stay with a paragraph long enough to notice its structure, you start to hear the writer thinking, and that is where understanding begins.", "慢读与速度本身无关，它关乎注意力。当你在一个段落上停留得足够久，久到能察觉它的结构，你就开始听见作者在思考，而理解正是从这里开始的。"],
  ["Reading in a second language makes this even clearer. Every unfamiliar word is a small pause, and those pauses are not obstacles. They are the moments when the text asks you to look again.", "用第二语言阅读时，这一点尤为明显。每个陌生的词都是一次短暂的停顿，而这些停顿并非障碍，它们正是文本请你再看一眼的时刻。"],
  ["A good translation should feel like it was always there, sitting quietly beneath the original, ready when you need it and invisible when you do not.", "一段好的译文应该让人觉得它本来就在那里，安静地伏在原文之下，需要时触手可及，不需要时了无痕迹。"],
  ["So the next time an article deserves it, resist the urge to skim. Read it twice. Read it in two languages. Let it take the time it needs.", "所以下次遇到一篇值得的文章，请抵住一扫而过的冲动。读它两遍，用两种语言读它，给它应得的时间。"],
];
const KICKER = "FIELD NOTES · READING";
const ZH = new Map([[TITLE, "为什么慢读依然重要"], [KICKER, "读书札记 · 阅读"], ...PARAGRAPHS]);

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title>
<style>
  body { margin: 0; background: #fbfaf7; color: #22201c; font: 18px/1.75 Georgia, "Times New Roman", serif; }
  main { max-width: 680px; margin: 0 auto; padding: 56px 24px 80px; }
  .kicker { margin: 0 0 14px; color: #8a8378; font: 600 13px/1 -apple-system, "Segoe UI", sans-serif; letter-spacing: .14em; }
  h1 { margin: 0 0 28px; font-size: 40px; line-height: 1.2; letter-spacing: -.01em; }
  p { margin: 0 0 22px; }
</style></head>
<body><main><p class="kicker">${KICKER}</p><h1>${TITLE}</h1>${PARAGRAPHS.map(([text]) => `<p>${text}</p>`).join("")}</main></body></html>`;

const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(ARTICLE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${resolve("dist")}`, `--load-extension=${resolve("dist")}`],
});
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
await context.route("https://translate.googleapis.com/**", async (route) => {
  const texts = new URLSearchParams(route.request().postData() ?? "").getAll("q");
  const auto = new URL(route.request().url()).searchParams.get("sl") === "auto";
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(texts.map((text) => (auto ? [ZH.get(text) ?? text, "en"] : ZH.get(text) ?? text))) });
});

const togglePage = () => worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAGE" });
});

await mkdir(OUT, { recursive: true });
const page = await context.newPage();
await page.goto(`${origin}/article`);
await page.waitForTimeout(500);

await togglePage();
await page.waitForFunction(() => document.querySelectorAll(".fanyi-translation").length === document.querySelectorAll("main > *").length && !document.querySelector(".fanyi-translation[data-loading]"));
await page.screenshot({ path: `${OUT}/screenshot-1-page.png` });
await togglePage();

// 从段首拖到段尾，选区正好是整段文字，和译文表里的键一致
const box = await page.locator("main p:nth-of-type(5)").boundingBox();
await page.mouse.move(box.x + 1, box.y + 8);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 1, box.y + box.height - 8, { steps: 4 });
await page.mouse.up();
// 划词卡片挂在 closed shadow root 上，只能等宿主元素出现后再留一点渲染时间
await page.waitForSelector("[data-fanyi-root='selection']");
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/screenshot-2-selection.png` });

const options = await context.newPage();
await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#service`);
await options.waitForFunction(() => document.querySelectorAll("#options-target-language option").length > 0);
await options.waitForTimeout(300);
await options.screenshot({ path: `${OUT}/screenshot-3-options.png` });

const icon = await readFile("public/icons/icon.svg", "utf8");
const tile = await context.newPage();
await tile.setViewportSize({ width: 440, height: 280 });
await tile.setContent(`<body style="margin:0;height:280px;display:flex;align-items:center;justify-content:center;gap:28px;background:#153b31;font:700 52px/1 Inter,-apple-system,'Segoe UI',sans-serif;color:#b7e8ce;letter-spacing:-.03em">${icon.replace("<svg ", '<svg style="width:128px;height:128px;border-radius:34px;box-shadow:0 18px 40px rgba(0,0,0,.35)" ')}<span>fanyi</span></body>`);
await tile.screenshot({ path: `${OUT}/promo-small.png` });

await context.close();
server.close();
console.log(`store assets written to ${OUT}/`);
