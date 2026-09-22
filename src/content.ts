import { TRANSLATE_PORT, type PageStateResponse, type RuntimeMessage, type TranslationResponse } from "./messages";
import { batchSizeFor, breakSentences, leadingCount, splitText } from "./paragraphs";
import { chineseScript, DEFAULT_SETTINGS, getSettings, isSameLanguage, isSiteExcluded, saveSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES, type LanguageOption, type Settings } from "./settings";

const BLOCK_SELECTOR = "p, li, blockquote, figcaption, h1, h2, h3, h4, h5, h6, td, th, dd";
const TEXT_SELECTOR = "div, span, a, dt, label, summary, small, strong, em, b, i";
const ALWAYS_SKIPPED = "script, style, noscript, code, pre, textarea, input, select, button, [contenteditable='true'], [aria-hidden='true'], [data-fanyi-root], .fanyi-translation";
const MAX_PAGE_BLOCKS = 1000;
// 检测给的占比按字节统计，换算时也要用字节数：一句话以上的外语正文就值得翻译，几个外来词不算
const MIN_LANGUAGE_BYTES = 40;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CONCURRENT_BATCHES = 3;
const INHERITED_TEXT_PROPERTIES = ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"];
const HAS_LETTER = /\p{L}/u;

interface Paragraph {
  element: HTMLElement;
  text: string;
  parts?: { node: Text; original: string; text: string; translated?: string }[];
}

interface Scan {
  elements: HTMLElement[];
  index: number;
}

interface Run {
  failed: number;
  lastFailure: string;
}

// 内容脚本会注入每个框架：顶层框架负责与扩展界面对话，子框架只管翻译自己的正文
const topFrame = window === window.top;
// 1x1 这类框架里的正文再宽也没人看得见，不该占用翻译请求
const MIN_FRAME_WIDTH = 120;
const MIN_FRAME_HEIGHT = 60;

function readableFrame(): boolean {
  return topFrame || (window.innerWidth >= MIN_FRAME_WIDTH && window.innerHeight >= MIN_FRAME_HEIGHT);
}

// 排除站点按用户看到的那个网站算，子框架要跟着顶层页面的主机名走
function pageHostname(): string {
  const ancestors = location.ancestorOrigins;
  const top = ancestors.length ? ancestors[ancestors.length - 1] : "";
  if (!top) return location.hostname;
  try {
    return new URL(top).hostname;
  } catch {
    return location.hostname;
  }
}

let settings: Settings = DEFAULT_SETTINGS;
let active = false;
let translating = false;
let supported = true;
let generation = 0;
let originalTitle: string | null = null;
let translatedTitle: string | null = null;
let startup: Promise<PageStateResponse> | null = null;
let mutationTimer: number | undefined;
let selectionTimer: number | undefined;
let selectionRequest = 0;
let selectionHost: HTMLDivElement | null = null;
let selectionButton: HTMLDivElement | null = null;
const queue: Paragraph[] = [];
const waiting = new Map<HTMLElement, Paragraph>();
const paragraphOf = new WeakMap<HTMLElement, Paragraph>();
const inPlaceParagraphs = new Set<Paragraph>();
const pageRequests = new Set<() => void>();
const selectionRequests = new Set<() => void>();
let run: Run | null = null;
let inflight = 0;
let failureStreak = 0;

const mutationObserver = new MutationObserver((mutations) => {
  if (!active) return;
  const hasRemovedContent = mutations.some((mutation) => Array.from(mutation.removedNodes).some((node) =>
    !(mutation.target instanceof Element && mutation.target.closest(".fanyi-translation, [data-fanyi-root]"))
    && (node instanceof Text || (node instanceof Element && !node.matches(".fanyi-translation, [data-fanyi-root]")))));
  if (hasRemovedContent) pruneInPlaceTranslations();
  const hasNewContent = mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => node instanceof HTMLElement && !node.closest(".fanyi-translation, [data-fanyi-root]")));
  if (!hasNewContent) return;
  window.clearTimeout(mutationTimer);
  mutationTimer = window.setTimeout(() => void translatePage(false), 700);
});

const visibilityObserver = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).flatMap((entry) => {
    const paragraph = entry.target instanceof HTMLElement ? waiting.get(entry.target) : undefined;
    if (!paragraph) return [];
    waiting.delete(paragraph.element);
    visibilityObserver.unobserve(paragraph.element);
    return [paragraph];
  });
  if (!visible.length) return;
  // 用户刚滚到的段落优先；连续失败的暂停也由这次滚动解除，服务没恢复就只多失败这一批
  queue.unshift(...visible);
  failureStreak = 0;
  drainQueue();
}, { rootMargin: "50% 0px" });

function pageState(): PageStateResponse {
  pruneInPlaceTranslations();
  return {
    // 正在翻译的页面一律报告开关已开，开关的写入是异步的，中途广播的状态不能倒退回未开启
    enabled: settings.pageTranslationEnabled || pageTranslationOn(),
    active,
    translating,
    supported,
    translatedCount: document.querySelectorAll(".fanyi-translation:not([data-loading]):not([data-error])").length
      + Array.from(inPlaceParagraphs).filter(({ element, parts }) => element.isConnected && parts?.some(({ node, translated }) => translated !== undefined && element.contains(node) && node.data === translated)).length,
  };
}

function notifyState(): void {
  if (!topFrame) return;
  void chrome.runtime.sendMessage({ type: "PAGE_STATE_CHANGED", state: pageState() } satisfies RuntimeMessage).catch(() => undefined);
}

function extractText(element: HTMLElement): string {
  return element.innerText.replace(/\s+/g, " ").trim();
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 12 && rect.height > 4;
}

function skipSelector(): string {
  const regions: string[] = [];
  if (!settings.translateAllAreas) regions.push("nav", "header", "footer");
  if (!settings.translateAllAreas && !settings.translateAside) regions.push("aside");
  return [...regions, ALWAYS_SKIPPED].join(", ");
}

function candidateSelector(): string {
  // 智能模式只认 p/li 等正文块；放开区域后 div/a/span 这类文本容器也算段落
  if (settings.translateAllAreas) return `${BLOCK_SELECTOR}, ${TEXT_SELECTOR}`;
  if (settings.translateAside) return `${BLOCK_SELECTOR}, aside :is(${TEXT_SELECTOR})`;
  return BLOCK_SELECTOR;
}

function hasOwnText(element: HTMLElement): boolean {
  return Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(node.textContent ?? ""));
}

function hasCollectedAncestor(element: HTMLElement, collected: Set<HTMLElement>): boolean {
  for (let node = element.parentElement; node; node = node.parentElement) if (collected.has(node)) return true;
  return false;
}

function translatableText(element: HTMLElement, skip: string): string | undefined {
  if (element.closest("[data-fanyi-processed]") || element.closest(skip)) return undefined;
  if (element.querySelector(BLOCK_SELECTOR) || !isVisible(element)) return undefined;
  const text = extractText(element);
  if (text.length < settings.minParagraphLength || text.length > 5000) return undefined;
  if (!HAS_LETTER.test(text) || element.children.length > 12) return undefined;
  return text;
}

function startScan(): Scan {
  return { elements: Array.from(document.querySelectorAll<HTMLElement>(candidateSelector())), index: 0 };
}

function textParts(element: HTMLElement): NonNullable<Paragraph["parts"]> {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        if (node.matches(ALWAYS_SKIPPED) || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return HAS_LETTER.test(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const parts: NonNullable<Paragraph["parts"]> = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) parts.push({ node, original: node.data, text: node.data.replace(/\s+/g, " ").trim() });
  }
  return parts;
}

function collectParagraphs(scan: Scan): Paragraph[] {
  const skip = skipSelector();
  const collected = new Set<HTMLElement>();
  const paragraphs: Paragraph[] = [];
  // 一次最多采 1000 块以免扫描卡顿；游标留在 scan 里，空闲时从断点接着采而不是整页重扫
  for (; scan.index < scan.elements.length && paragraphs.length < MAX_PAGE_BLOCKS; scan.index += 1) {
    const element = scan.elements[scan.index];
    if (!element.matches(BLOCK_SELECTOR) && !hasOwnText(element)) continue;
    if (hasCollectedAncestor(element, collected)) continue;
    const text = translatableText(element, skip);
    if (!text) continue;
    const parts = settings.translationStyle === "in-place" ? textParts(element) : undefined;
    if (parts?.length === 0) continue;
    collected.add(element);
    paragraphs.push({ element, text, parts });
  }
  return paragraphs;
}

function canHoldTranslation(source: HTMLElement): boolean {
  if (source.matches("td, th")) return true;
  const style = getComputedStyle(source);
  if (/flex|grid|box/.test(style.display) || style.overflowX !== "visible" || style.overflowY !== "visible") return false;
  // 译文在前时被挤出去的是原文，所以看整体内容是否装得下而不是译文的位置
  return source.scrollHeight <= source.clientHeight + 1;
}

function translationPosition(): "before" | "after" {
  return settings.translationStyle !== "in-place" && settings.translationFirst ? "before" : "after";
}

function moveTranslationOutside(source: HTMLElement, translation: HTMLElement): void {
  const style = getComputedStyle(source);
  const copied = [...INHERITED_TEXT_PROPERTIES];
  // 原文自带背景时一并带走，否则复制过来的字色可能与父容器背景撞色
  if (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none") copied.push("background", "padding");
  for (const property of copied) translation.style.setProperty(property, style.getPropertyValue(property), "important");
  translation.style.setProperty("font-size", `calc(${style.fontSize} * var(--fanyi-font-scale, .95))`, "important");
  source.insertAdjacentElement(translation.dataset.position === "before" ? "beforebegin" : "afterend", translation);
}

function settleTranslation(source: HTMLElement, translation: HTMLElement): void {
  if (translation.parentElement === source && !canHoldTranslation(source)) moveTranslationOutside(source, translation);
}

function placeTranslation(source: HTMLElement, translation: HTMLElement): void {
  translation.dataset.position = translationPosition();
  // 先放进原文内部以继承排版；被裁剪或处于 flex/grid 时外置并复制文字样式
  if (translation.dataset.position === "before") source.prepend(translation);
  else source.append(translation);
  settleTranslation(source, translation);
}

function createTranslationElement(paragraph: Paragraph): HTMLDivElement {
  const translation = document.createElement("div");
  translation.className = "fanyi-translation";
  translation.dataset.loading = settings.loadingStyle;
  translation.dataset.style = settings.translationStyle;
  translation.style.setProperty("--fanyi-font-scale", String(settings.translationStyle === "in-place" ? 1 : settings.fontScale / 100));
  paragraphOf.set(translation, paragraph);
  placeTranslation(paragraph.element, translation);
  return translation;
}

function showFailure(translation: HTMLElement, message: string): void {
  delete translation.dataset.loading;
  translation.dataset.error = "true";
  translation.textContent = `翻译失败：${message} `;
  const retry = document.createElement("a");
  retry.className = "fanyi-retry";
  retry.href = "#";
  retry.textContent = "重试";
  retry.addEventListener("click", (event) => {
    event.preventDefault();
    retryTranslation(translation);
  });
  translation.append(retry);
}

function retryTranslation(translation: HTMLElement): void {
  const paragraph = paragraphOf.get(translation);
  if (!paragraph || !active) return;
  translation.remove();
  queue.unshift(paragraph);
  // 用户主动重试就解除连续失败带来的暂停
  failureStreak = 0;
  drainQueue();
}

function fillTranslation(translation: HTMLElement, text: string): void {
  if (paragraphOf.get(translation)?.text === text) {
    translation.remove();
    return;
  }
  const content = settings.sentenceBreaks ? breakSentences(text) : text;
  if (content !== text) translation.dataset.breaks = "true";
  translation.textContent = content;
  delete translation.dataset.loading;
}

function fillInPlace(paragraph: Paragraph, translation: HTMLElement, texts: string[]): void {
  translation.remove();
  const { element, parts } = paragraph;
  if (!parts || !element.isConnected || parts.some(({ node, original }) => !element.contains(node) || node.data !== original)) return;
  parts.forEach((part, index) => {
    if (part.text === texts[index]) return;
    part.translated = part.original.replace(/\S[\s\S]*\S|\S/u, () => texts[index]);
    part.node.data = part.translated;
    inPlaceParagraphs.add(paragraph);
  });
}

function applyTranslationStyle(previousStyle: Settings["translationStyle"]): void {
  if ((previousStyle === "in-place") !== (settings.translationStyle === "in-place") && pageTranslationOn()) {
    void translatePage(true);
    return;
  }
  const translations = Array.from(document.querySelectorAll<HTMLElement>(".fanyi-translation"));
  const position = translationPosition();
  translations.forEach((element) => {
    element.dataset.style = settings.translationStyle;
    element.style.setProperty("--fanyi-font-scale", String(settings.translationStyle === "in-place" ? 1 : settings.fontScale / 100));
    if (element.dataset.loading) element.dataset.loading = settings.loadingStyle;
  });
  // 字号、样式或位置变化后，原本装得下的固定高度原文可能装不下了
  translations.forEach((element) => {
    const source = paragraphOf.get(element)?.element;
    if (!source) return;
    if (element.dataset.position === position) settleTranslation(source, element);
    else placeTranslation(source, element);
  });
}

function showNotice(text: string): void {
  // 子框架里的提示会被框架边界裁切，而且每个框架各弹一次，只让顶层框架提示
  if (!topFrame) return;
  document.querySelector(".fanyi-notice")?.remove();
  const notice = document.createElement("div");
  notice.className = "fanyi-notice";
  notice.textContent = text;
  document.documentElement.append(notice);
  window.setTimeout(() => notice.remove(), 2500);
}

function sendTranslationRequest(texts: string[], sourceLanguage: string, targetLanguage: string, requests: Set<() => void>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: TRANSLATE_PORT });
    const cancel = (): void => {
      port.disconnect();
      reject(new Error("翻译已取消"));
    };
    requests.add(cancel);
    port.onMessage.addListener((response: TranslationResponse) => {
      requests.delete(cancel);
      port.disconnect();
      if (!response.ok || !response.translations) reject(new Error(response.error || "翻译失败"));
      else if (response.translations.length !== texts.length) reject(new Error("译文数量不一致"));
      else resolve(response.translations);
    });
    // 后台被回收或扩展重载时对端会断开
    port.onDisconnect.addListener(() => {
      requests.delete(cancel);
      reject(new Error("后台连接中断"));
    });
    port.postMessage({ type: "TRANSLATE_TEXTS", texts, sourceLanguage, targetLanguage } satisfies RuntimeMessage);
  });
}

async function requestTranslations(texts: string[], sourceLanguage: string, targetLanguage: string, options: { detectTargetLanguage: boolean }, stillWanted: () => boolean, requests: Set<() => void>): Promise<string[]> {
  // 正文、标题、划词都经过这里：超长文本拆段、按段落数和字符数分批，再按原顺序回组
  const unnecessary: boolean[] = [];
  while (unnecessary.length < texts.length) {
    if (!stillWanted()) throw new Error("翻译已取消");
    const batch = texts.slice(unnecessary.length, unnecessary.length + settings.maxParagraphsPerRequest);
    unnecessary.push(...await Promise.all(batch.map((text) => translationUnnecessary(text, sourceLanguage, targetLanguage, options.detectTargetLanguage))));
  }
  const pieces = texts.map((text, index) => unnecessary[index] ? [] : splitText(text, settings.maxCharsPerRequest));
  const flat = pieces.flat();
  const translated: string[] = [];
  while (translated.length < flat.length) {
    // 调用方已停止或重启时不再开始新的分片请求，已发出的请求自然结束
    if (!stillWanted()) throw new Error("翻译已取消");
    const window = flat.slice(translated.length, translated.length + settings.maxParagraphsPerRequest);
    const batch = window.slice(0, batchSizeFor(window.map((text) => text.length), settings.maxCharsPerRequest));
    const neededIndexes = batch.flatMap((text, index) => HAS_LETTER.test(text) ? [index] : []);
    const batchTranslations = [...batch];
    if (neededIndexes.length) {
      const received = await sendTranslationRequest(neededIndexes.map((index) => batch[index]), sourceLanguage, targetLanguage, requests);
      neededIndexes.forEach((index, offset) => { batchTranslations[index] = received[offset]; });
    }
    translated.push(...batchTranslations);
  }
  let cursor = 0;
  return pieces.map((chunks, index) => {
    const results = translated.slice(cursor, (cursor += chunks.length));
    // 分片全部未变时还原原文，避免回组分隔符制造差异。
    return chunks.every((chunk, offset) => chunk === results[offset]) ? texts[index] : results.join(" ");
  });
}

function drainQueue(): void {
  // 连续失败多半是密钥或额度问题，暂停到有一批成功、用户重试或滚动、重启为止；后台补采和 DOM 变化都不解除
  if (!active || !queue.length || failureStreak >= MAX_CONSECUTIVE_FAILURES) return;
  if (!run) {
    run = { failed: 0, lastFailure: "" };
    translating = true;
    notifyState();
  }
  // ponytail: 并发中的批次不计入连续失败，最坏多发 2 批才停
  while (queue.length && inflight < MAX_CONCURRENT_BATCHES) void translateBatch(run);
}

async function translateBatch(current: Run): Promise<void> {
  inflight += 1;
  const candidates = queue.slice(0, settings.maxParagraphsPerRequest);
  const batch = queue.splice(0, batchSizeFor(candidates.map(({ text }) => text.length), settings.maxCharsPerRequest));
  const placeholders = batch.map((paragraph) => createTranslationElement(paragraph));
  try {
    const texts = batch.flatMap(({ text, parts }) => parts ? parts.map((part) => part.text) : [text]);
    const translations = await requestTranslations(texts, settings.sourceLanguage, settings.targetLanguage, { detectTargetLanguage: settings.detectSameLanguage }, () => run === current, pageRequests);
    // 停止或重启后这一轮已被丢弃，旧结果不能碰新队列和新占位符
    if (run !== current) return;
    let cursor = 0;
    batch.forEach((paragraph, index) => {
      const results = translations.slice(cursor, (cursor += paragraph.parts?.length ?? 1));
      if (paragraph.parts) fillInPlace(paragraph, placeholders[index], results);
      else fillTranslation(placeholders[index], results[0]);
    });
    // 真实译文比占位符长，固定高度的原文可能此时才装不下
    placeholders.forEach((placeholder, index) => settleTranslation(batch[index].element, placeholder));
    failureStreak = 0;
  } catch (error) {
    if (run !== current) return;
    current.lastFailure = error instanceof Error ? error.message : "翻译失败";
    current.failed += batch.length;
    failureStreak += 1;
    placeholders.forEach((placeholder) => showFailure(placeholder, current.lastFailure));
  }
  inflight -= 1;
  drainQueue();
  if (!inflight) finishRun(current);
}

function finishRun(current: Run): void {
  run = null;
  translating = false;
  if (current.failed) showNotice(`${current.failed} 个段落翻译失败：${current.lastFailure}`);
  notifyState();
}

function primarySubtag(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

// 检测只给出语言，声明可能带着更精确的地区或脚本
function refineLanguage(language: string, declared: string, sample: string): string {
  if (primarySubtag(declared) === primarySubtag(language)) return declared;
  // 检测分不出中文简繁，声明又给不出时按正文里的简繁专用字判断
  // 字表只收常用字，判不出来就是脚本未知，此时不能当成与目标语言相同，宁可多翻一遍也别把繁体正文挡掉
  if (primarySubtag(language) === "zh") return chineseScript(sample) ?? "";
  return language;
}

const encoder = new TextEncoder();

function matchesTarget(language: string, declared: string, text: string): boolean {
  return isSameLanguage(refineLanguage(language, declared, text), settings.targetLanguage);
}

async function translationUnnecessary(text: string, sourceLanguage: string, targetLanguage: string, detectTargetLanguage: boolean): Promise<boolean> {
  if (!HAS_LETTER.test(text)) return true;
  if (sourceLanguage !== "auto") return isSameLanguage(sourceLanguage, targetLanguage);
  if (!detectTargetLanguage) return false;
  try {
    const { isReliable, languages } = await chrome.i18n.detectLanguage(text);
    const found = languages.filter(({ language }) => language && language !== "und");
    return isReliable && found.length > 0 && found.every(({ language }) => isSameLanguage(refineLanguage(language, "", text), targetLanguage));
  } catch {
    return false;
  }
}

// 占比精度不足以判定时才逐段复核：每一段都确认是目标语言才允许拒译，确认不了就当作有外语
// 不看 isReliable：Chromium 对不足 50 字节的输入一律标记为不可靠，会把刚过门槛的外语段落漏掉
async function everyParagraphInTarget(paragraphs: Paragraph[], declared: string): Promise<boolean> {
  for (const { text } of paragraphs) {
    const bytes = encoder.encode(text).length;
    // 比门槛还短的段落装不下够分量的外语，不必再检测
    if (bytes < MIN_LANGUAGE_BYTES) continue;
    const { languages } = await chrome.i18n.detectLanguage(text);
    const found = languages.filter(({ language }) => language && language !== "und");
    // 一段里也可能混着多种语言，只要有一种不是目标语言且可能过门槛，这一段就不算确认
    if (found.length === 0 || found.some(({ language, percentage }) => !matchesTarget(language, declared, text) && ((percentage + 1) / 100) * bytes >= MIN_LANGUAGE_BYTES)) return false;
  }
  return true;
}

// <html lang> 往往只是界面语言，邮箱一类应用的正文与它不是一种语言，所以按将要翻译的正文判断
async function alreadyInTargetLanguage(paragraphs: Paragraph[]): Promise<boolean> {
  if (settings.sourceLanguage !== "auto") return isSameLanguage(settings.sourceLanguage, settings.targetLanguage);
  const sample = paragraphs.map(({ text }) => text).join(" ");
  const declared = document.documentElement.lang;
  const { isReliable, languages } = await chrome.i18n.detectLanguage(sample);
  const [main, ...rest] = languages.filter(({ language }) => language && language !== "und");
  // 样本太短或页面没有可翻译正文时检测不可靠，只能退回页面自己声明的语言
  if (!isReliable || !main) {
    if (declared) return isSameLanguage(declared, settings.targetLanguage);
    return Boolean(main) && matchesTarget(main.language, declared, sample);
  }
  if (!matchesTarget(main.language, declared, sample)) return false;
  const foreign = rest.filter(({ language }) => !matchesTarget(language, declared, sample));
  const bytes = encoder.encode(sample).length;
  // 占比按字节统计且向下取整：下界过门槛就是实质外语，上界不到门槛才能断定是零星词汇，中间只能逐段复核
  if (foreign.some(({ percentage }) => (percentage / 100) * bytes >= MIN_LANGUAGE_BYTES)) return false;
  if (!foreign.some(({ percentage }) => ((percentage + 1) / 100) * bytes >= MIN_LANGUAGE_BYTES)) return true;
  return everyParagraphInTarget(paragraphs, declared);
}

async function translateTitle(): Promise<void> {
  const title = document.title.trim();
  if (!title || originalTitle !== null) return;
  originalTitle = document.title;
  const currentGeneration = generation;
  try {
    const [translated] = await requestTranslations([title], settings.sourceLanguage, settings.targetLanguage, { detectTargetLanguage: false }, () => active && currentGeneration === generation, pageRequests);
    // 网页在此期间自己改了标题就不再覆盖
    if (!active || currentGeneration !== generation || !translated || translated === title || document.title !== originalTitle) return;
    translatedTitle = settings.translationStyle === "in-place" ? translated : `${translated} | ${originalTitle}`;
    document.title = translatedTitle;
  } catch {
    // 标题翻译失败不打断正文，正文批次会把同一错误显示给用户
  }
}

function translatePage(reset: boolean, scan = startScan()): Promise<PageStateResponse> {
  // 记录进行中的启动，语言检测期间再次 TOGGLE 才能取消它；旧启动结束时不能清掉新启动的记录
  const current: Promise<PageStateResponse> = startTranslation(reset, scan).finally(() => {
    if (startup === current) startup = null;
  });
  startup = current;
  return current;
}

async function startTranslation(reset: boolean, scan: Scan): Promise<PageStateResponse> {
  if (!supported) return pageState();
  // 框架小到读不了就不翻译；若是重启，先把旧译文和运行状态清掉，框架撑开后才会按最新设置重来
  if (!readableFrame()) {
    if (reset) stopTranslation();
    return pageState();
  }
  if (reset) removePageTranslations();
  const starting = reset || !active;
  // 每次启动都换一个代次，仍在等语言检测的更早启动会在检测返回后自行放弃
  if (starting) generation += 1;
  const currentGeneration = generation;
  const paragraphs = collectParagraphs(scan);
  if (starting && settings.detectSameLanguage) {
    const skip = await alreadyInTargetLanguage(paragraphs.slice(0, 20));
    if (currentGeneration !== generation) return pageState();
    if (skip) {
      // 正文可能在框架里，顶层自己不需要翻译不代表整页不需要
      if (!window.frames.length) showNotice("页面语言与目标语言相同，无需翻译");
      return pageState();
    }
  }

  active = true;
  paragraphs.forEach(({ element }) => element.dataset.fanyiProcessed = "true");
  // 首屏字符预算内的段落立即翻译，其余等滚动到可视区域附近再翻译
  const eager = settings.translateFullPage ? paragraphs.length : starting ? leadingCount(paragraphs.map(({ text }) => text.length), settings.eagerCharacters) : 0;
  paragraphs.slice(eager).forEach((paragraph) => {
    waiting.set(paragraph.element, paragraph);
    visibilityObserver.observe(paragraph.element);
  });
  queue.push(...paragraphs.slice(0, eager));
  if (starting && topFrame && settings.translateTitle) void translateTitle();
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  notifyState();
  drainQueue();
  if (scan.index < scan.elements.length) {
    requestIdleCallback(() => {
      if (active && currentGeneration === generation) void translatePage(false, scan);
    });
  }
  return pageState();
}

function restoreTextPart({ node, original, translated }: NonNullable<Paragraph["parts"]>[number]): void {
  // 网页已更新的文字归网页所有，只撤销仍与本轮译文相同的文本。
  if (translated !== undefined && node.data === translated) node.data = original;
}

function pruneInPlaceTranslations(): void {
  inPlaceParagraphs.forEach((paragraph) => {
    const { element } = paragraph;
    paragraph.parts = paragraph.parts?.filter((part) => {
      if (element.isConnected && element.contains(part.node)) return true;
      // 网页可能重新使用移除的节点，释放快照前先还原扩展仍持有的译文。
      restoreTextPart(part);
      return false;
    });
    if (paragraph.parts?.length) return;
    inPlaceParagraphs.delete(paragraph);
    delete element.dataset.fanyiProcessed;
  });
}

function removePageTranslations(): void {
  generation += 1;
  mutationObserver.disconnect();
  visibilityObserver.disconnect();
  waiting.clear();
  queue.length = 0;
  inPlaceParagraphs.forEach(({ parts }) => parts?.forEach(restoreTextPart));
  inPlaceParagraphs.clear();
  document.querySelectorAll(".fanyi-translation").forEach((element) => element.remove());
  document.querySelectorAll<HTMLElement>("[data-fanyi-processed]").forEach((element) => delete element.dataset.fanyiProcessed);
  document.querySelector(".fanyi-notice")?.remove();
  // 只撤销扩展自己写入的标题，网页后来更新的标题保持不动
  if (originalTitle !== null && document.title === translatedTitle) document.title = originalTitle;
  originalTitle = null;
  translatedTitle = null;
  translating = false;
  run = null;
  inflight = 0;
  failureStreak = 0;
  // 在途请求随本轮作废，断开端口让后台停止请求和重试
  pageRequests.forEach((cancel) => cancel());
  pageRequests.clear();
}

function pageTranslationOn(): boolean {
  return active || startup !== null;
}

function stopTranslation(): void {
  active = false;
  removePageTranslations();
  notifyState();
}

async function togglePage(): Promise<PageStateResponse> {
  // 网页翻译是全局开关，其他标签页和之后打开的网页都跟着这个状态走
  // 开关已打开就一律关掉它，本页可能因为语言相同而没有译文，同样要能从这里关
  if (settings.pageTranslationEnabled || pageTranslationOn()) {
    settings = await saveSettings({ pageTranslationEnabled: false });
    stopTranslation();
    return pageState();
  }
  // 先启动再写开关：translatePage 会同步登记 startup，本框架不会被存储回调重复启动
  // 顶层自己可能因为语言相同而不翻译，但正文可能在框架里，开关仍然要打开
  const running = translatePage(false);
  settings = await saveSettings({ pageTranslationEnabled: true });
  await running;
  return pageState();
}

function selectionStyles(): string {
  return `
    :host { all: initial; position: fixed; z-index: 2147483647; font-family: Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; color: #17372d; }
    * { box-sizing: border-box; }
    .card { position: relative; display: flex; flex-direction: column; width: 380px; max-height: calc(100vh - 20px); overflow: hidden; border: 1px solid rgba(32,76,61,.16); border-radius: 15px; background: rgba(255,255,255,.98); box-shadow: 0 18px 55px rgba(17,45,36,.22), 0 2px 8px rgba(17,45,36,.08); backdrop-filter: blur(18px); animation: in .16s ease-out; }
    .close { position: absolute; right: 8px; top: 8px; width: 26px; height: 26px; border: 0; border-radius: 7px; color: #81928b; background: transparent; cursor: pointer; font-size: 18px; line-height: 1; }
    .close:hover { background: #edf3ef; color: #355f51; }
    .source { flex: none; max-height: 110px; padding: 14px 40px 12px 16px; overflow: auto; border-bottom: 1px solid #e9efeb; background: linear-gradient(145deg,#f6fbf8,#fff); color: #64776f; font: 400 14px/1.55 Georgia,"Times New Roman",serif; }
    .result { flex: 1 1 auto; min-height: 64px; padding: 16px; overflow: auto; color: #1f4437; font: 500 16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; white-space: pre-wrap; }
    .result.loading { color: #8ca098; }
    .result.loading::after { content: ""; display: inline-block; width: 4px; height: 4px; margin-left: 5px; border-radius: 50%; background: #4c8b73; box-shadow: 8px 0 #85b9a4, 16px 0 #c0d8ce; animation: dots 1s infinite; }
    .error { color: #a2594d; }
    .actions { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 11px; border-top: 1px solid #edf1ef; background: #fbfcfb; }
    .languages { display: flex; align-items: center; gap: 2px; color: #94a19c; font-size: 12px; }
    select { max-width: 96px; padding: 5px 2px; border: 0; border-radius: 6px; color: #55756a; background: transparent; cursor: pointer; font: 600 12px/1.2 sans-serif; }
    select:hover { background: #eaf4ef; }
    .buttons { display: flex; gap: 4px; }
    .action { height: 30px; padding: 0 10px; border: 0; border-radius: 7px; color: #55756a; background: transparent; cursor: pointer; font: 600 12px/1 sans-serif; }
    .action:hover { color: #20543f; background: #eaf4ef; }
    .action:disabled { opacity: .5; cursor: default; }
    @keyframes in { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
    @keyframes dots { 50% { opacity: .35; } }
  `;
}

function positionSelectionHost(host: HTMLElement, rect?: DOMRect): void {
  requestAnimationFrame(() => {
    const panelRect = host.getBoundingClientRect();
    const anchor = rect ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0);
    const left = Math.min(Math.max(10, anchor.left + anchor.width / 2 - panelRect.width / 2), window.innerWidth - panelRect.width - 10);
    const below = anchor.bottom + 10;
    const top = below + panelRect.height < window.innerHeight ? below : Math.max(10, anchor.top - panelRect.height - 10);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  });
}

function speak(text: string, language: string): void {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  speechSynthesis.speak(utterance);
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  });
}

function languageOptions(languages: LanguageOption[], selected: string): HTMLOptionElement[] {
  return languages.map(({ code, label }) => new Option(label, code, false, code === selected));
}

function closeSelection(): void {
  selectionHost?.remove();
  selectionHost = null;
  // 弹窗没了就不该再为它请求或重试
  selectionRequests.forEach((cancel) => cancel());
  selectionRequests.clear();
}

async function showSelectionTranslation(text: string, rect?: DOMRect): Promise<void> {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (normalized.length < 2) return;
  const openingRequest = ++selectionRequest;
  closeSelection();
  selectionButton?.remove();
  if (await translationUnnecessary(normalized, settings.selectionSourceLanguage, settings.selectionTargetLanguage, true) || openingRequest !== selectionRequest) return;

  const host = document.createElement("div");
  host.dataset.fanyiRoot = "selection";
  host.style.left = "10px";
  host.style.top = "10px";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${selectionStyles()}</style><section class="card" role="dialog" aria-label="划词翻译"><button class="close" title="关闭" aria-label="关闭">×</button><div class="source"></div><div class="result loading" aria-live="polite">正在理解这段文字</div><div class="actions"><div class="languages"><select class="from" aria-label="源语言"></select>→<select class="to" aria-label="目标语言"></select></div><div class="buttons"><button class="action speak-source">朗读原文</button><button class="action copy" disabled>复制译文</button></div></div></section>`;
  document.documentElement.append(host);
  selectionHost = host;
  const source = shadow.querySelector<HTMLElement>(".source");
  const result = shadow.querySelector<HTMLElement>(".result");
  const from = shadow.querySelector<HTMLSelectElement>(".from");
  const to = shadow.querySelector<HTMLSelectElement>(".to");
  const copyButton = shadow.querySelector<HTMLButtonElement>(".copy");
  if (!source || !result || !from || !to || !copyButton) return;
  source.textContent = normalized;
  from.replaceChildren(...languageOptions(SOURCE_LANGUAGES, settings.selectionSourceLanguage));
  to.replaceChildren(...languageOptions(TARGET_LANGUAGES, settings.selectionTargetLanguage));
  shadow.querySelector(".close")?.addEventListener("click", closeSelection);
  shadow.querySelector(".speak-source")?.addEventListener("click", () => speak(normalized, from.value));
  host.addEventListener("pointerdown", (event) => event.stopPropagation());
  positionSelectionHost(host, rect);

  const translate = async (options = { detectTargetLanguage: true }): Promise<void> => {
    const requestId = ++selectionRequest;
    selectionRequests.forEach((cancel) => cancel());
    selectionRequests.clear();
    result.className = "result loading";
    result.textContent = "正在理解这段文字";
    copyButton.disabled = true;
    try {
      const [translation] = await requestTranslations([normalized], from.value, to.value, options, () => requestId === selectionRequest && host.isConnected, selectionRequests);
      if (requestId !== selectionRequest || !host.isConnected) return;
      if (translation === normalized) {
        closeSelection();
        return;
      }
      result.className = "result";
      result.textContent = translation;
      copyButton.disabled = false;
      copyButton.textContent = "复制译文";
      copyButton.onclick = () => {
        copyText(translation);
        copyButton.textContent = "已复制";
      };
      positionSelectionHost(host, rect);
    } catch (error) {
      if (requestId !== selectionRequest || !host.isConnected) return;
      result.className = "result error";
      result.textContent = error instanceof Error ? error.message : "翻译失败，请稍后重试";
    }
  };
  const changeLanguages = (): void => {
    void saveSettings({ selectionSourceLanguage: from.value, selectionTargetLanguage: to.value });
    void translate();
  };
  from.addEventListener("change", changeLanguages);
  to.addEventListener("change", changeLanguages);
  await translate({ detectTargetLanguage: false });
}

function showSelectionButton(text: string, rect: DOMRect, point: { x: number; y: number }): void {
  selectionButton?.remove();
  const host = document.createElement("div");
  host.dataset.fanyiRoot = "trigger";
  host.style.left = `${Math.min(point.x + 8, window.innerWidth - 42)}px`;
  host.style.top = `${Math.min(point.y + 12, window.innerHeight - 42)}px`;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>:host { all: initial; position: fixed; z-index: 2147483647; } button { width: 32px; height: 32px; padding: 0; border: 1px solid rgba(32,76,61,.16); border-radius: 27%; display: grid; place-items: center; color: #153b31; background: #b7e8ce; box-shadow: 0 6px 18px rgba(17,45,36,.22); cursor: pointer; font: 900 21.333333px/1 "Songti SC",SimSun,serif; } span { transform: translateY(-1px); }</style><button title="翻译选中文本" aria-label="翻译选中文本"><span>译</span></button>`;
  shadow.querySelector("button")?.addEventListener("click", () => void showSelectionTranslation(text, rect));
  document.documentElement.append(host);
  selectionButton = host;
}

function currentSelection(): { text: string; rect: DOMRect } | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const text = selection.toString();
  if (text.trim().length < 2) return undefined;
  return { text, rect: selection.getRangeAt(0).getBoundingClientRect() };
}

function scheduleSelectionTranslation(point?: { x: number; y: number }): void {
  if (!settings.selectionEnabled || !supported) return;
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    const selection = currentSelection();
    if (!selection) return;
    if (settings.selectionTrigger === "button") showSelectionButton(selection.text, selection.rect, point ?? { x: selection.rect.right, y: selection.rect.bottom });
    else void showSelectionTranslation(selection.text, selection.rect);
  }, 260);
}

function isInsideOverlay(event: Event): boolean {
  const path = event.composedPath();
  return [selectionHost, selectionButton].some((overlay) => overlay && path.includes(overlay));
}

document.addEventListener("mouseup", (event) => {
  if (!isInsideOverlay(event)) scheduleSelectionTranslation({ x: event.clientX, y: event.clientY });
});

document.addEventListener("keyup", (event) => {
  if (!isInsideOverlay(event) && (event.key.startsWith("Arrow") || event.key === "Shift")) scheduleSelectionTranslation();
});

document.addEventListener("pointerdown", (event) => {
  if (isInsideOverlay(event)) return;
  closeSelection();
  selectionButton?.remove();
  selectionButton = null;
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  // 弹窗、快捷键和右键菜单都只问顶层框架，子框架应答会让回复取决于哪个框架先返回
  if (!topFrame && message.type !== "TRANSLATE_CURRENT_SELECTION" && message.type !== "SHOW_SELECTION_TRANSLATION") return false;
  if (message.type === "GET_PAGE_STATE") {
    sendResponse(pageState());
    return false;
  }
  if (message.type === "TOGGLE_PAGE") {
    void togglePage().then(sendResponse);
    return true;
  }
  if (message.type === "RESTART_TRANSLATION") {
    // 发起方先写存储再发消息，storage 变更回调可能更晚到，重启必须自己读一遍最新设置
    void getSettings().then((nextSettings) => {
      settings = nextSettings;
      return translatePage(true);
    }).then(sendResponse);
    return true;
  }
  if (message.type === "SETTINGS_UPDATED") {
    void getSettings().then((nextSettings) => {
      const previousStyle = settings.translationStyle;
      settings = nextSettings;
      applyTranslationStyle(previousStyle);
      sendResponse(pageState());
    });
    return true;
  }
  if (message.type === "TRANSLATE_CURRENT_SELECTION") {
    const selection = currentSelection();
    if (selection) void showSelectionTranslation(selection.text, selection.rect);
    return false;
  }
  if (message.type === "SHOW_SELECTION_TRANSLATION") {
    void showSelectionTranslation(message.text);
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  void getSettings().then((nextSettings) => {
    const previousStyle = settings.translationStyle;
    settings = nextSettings;
    const wasSupported = supported;
    supported = !isSiteExcluded(pageHostname(), settings.excludedSites);
    applyTranslationStyle(previousStyle);
    if (!supported) {
      if (active) stopTranslation();
      return;
    }
    // 顶层框架由弹窗直接发消息重启，子框架只能从存储得知语言或服务变了
    // 之前因语言相同而跳过的框架也要重新评估，否则换了目标语言必须刷新才翻译
    if (!topFrame && settings.pageTranslationEnabled && (changes.sourceLanguage || changes.targetLanguage || changes.provider)) {
      void translatePage(true);
      return;
    }
    // 只在开关本身变化或本站重新被允许时跟随，免得每次改设置都重试语言相同而拒绝翻译的页面
    if (!changes.pageTranslationEnabled && wasSupported) return;
    if (settings.pageTranslationEnabled && !pageTranslationOn()) void translatePage(false);
    if (!settings.pageTranslationEnabled && pageTranslationOn()) stopTranslation();
  });
});

// 折叠或懒加载的框架撑开后才具备阅读尺寸，此时再按开关补上翻译
if (!topFrame) {
  window.addEventListener("resize", () => {
    if (supported && settings.pageTranslationEnabled && !pageTranslationOn() && readableFrame()) void translatePage(false);
  });
}

void getSettings().then((initialSettings) => {
  settings = initialSettings;
  supported = !isSiteExcluded(pageHostname(), settings.excludedSites);
  // 网页翻译开关打开时，进入网页就开始翻译
  if (supported && settings.pageTranslationEnabled) void translatePage(false);
});
