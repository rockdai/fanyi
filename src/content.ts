import type { PageStateResponse, RuntimeMessage, TranslationResponse } from "./messages";
import { batchSizeFor, breakSentences, leadingCount, splitText } from "./paragraphs";
import { DEFAULT_SETTINGS, getSettings, isSameLanguage, isSiteExcluded, saveSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES, type LanguageOption, type Settings } from "./settings";

const BLOCK_SELECTOR = "p, li, blockquote, figcaption, h1, h2, h3, h4, h5, h6, td, th, dd";
const TEXT_SELECTOR = "div, span, a, dt, label, summary, small, strong, em, b, i";
const ALWAYS_SKIPPED = "script, style, noscript, code, pre, textarea, input, select, button, [contenteditable='true'], [aria-hidden='true'], [data-fanyi-root], .fanyi-translation";
const MAX_PAGE_BLOCKS = 1000;
const INHERITED_TEXT_PROPERTIES = ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"];

interface Paragraph {
  element: HTMLElement;
  text: string;
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
const sourceOf = new WeakMap<HTMLElement, HTMLElement>();

const mutationObserver = new MutationObserver((mutations) => {
  if (!active) return;
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
  queue.push(...visible);
  void drainQueue(false);
}, { rootMargin: "50% 0px" });

function pageState(): PageStateResponse {
  return {
    active,
    translating,
    supported,
    translatedCount: document.querySelectorAll(".fanyi-translation:not([data-loading])").length,
  };
}

function notifyState(): void {
  void chrome.runtime.sendMessage({ type: "PAGE_STATE_CHANGED", active } satisfies RuntimeMessage).catch(() => undefined);
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
  if (!/[\p{L}\p{N}]/u.test(text) || element.children.length > 12) return undefined;
  return text;
}

function collectParagraphs(): Paragraph[] {
  const skip = skipSelector();
  const collected = new Set<HTMLElement>();
  const paragraphs: Paragraph[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(candidateSelector())) {
    if (paragraphs.length >= MAX_PAGE_BLOCKS) break;
    if (!element.matches(BLOCK_SELECTOR) && !hasOwnText(element)) continue;
    if (hasCollectedAncestor(element, collected)) continue;
    const text = translatableText(element, skip);
    if (!text) continue;
    collected.add(element);
    paragraphs.push({ element, text });
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

function moveTranslationOutside(source: HTMLElement, translation: HTMLElement): void {
  const style = getComputedStyle(source);
  const copied = [...INHERITED_TEXT_PROPERTIES];
  // 原文自带背景时一并带走，否则复制过来的字色可能与父容器背景撞色
  if (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none") copied.push("background", "padding");
  for (const property of copied) translation.style.setProperty(property, style.getPropertyValue(property), "important");
  translation.style.setProperty("font-size", `calc(${style.fontSize} * var(--fanyi-font-scale, .95))`, "important");
  source.insertAdjacentElement(settings.translationFirst ? "beforebegin" : "afterend", translation);
}

function settleTranslation(source: HTMLElement, translation: HTMLElement): void {
  if (translation.parentElement === source && !canHoldTranslation(source)) moveTranslationOutside(source, translation);
}

function placeTranslation(source: HTMLElement, translation: HTMLElement): void {
  translation.dataset.position = settings.translationFirst ? "before" : "after";
  // 先放进原文内部以继承排版；被裁剪或处于 flex/grid 时外置并复制文字样式
  if (settings.translationFirst) source.prepend(translation);
  else source.append(translation);
  settleTranslation(source, translation);
}

function createTranslationElement(source: HTMLElement): HTMLDivElement {
  const translation = document.createElement("div");
  translation.className = "fanyi-translation";
  translation.dataset.loading = settings.loadingStyle;
  translation.dataset.style = settings.translationStyle;
  translation.style.setProperty("--fanyi-font-scale", String(settings.fontScale / 100));
  sourceOf.set(translation, source);
  placeTranslation(source, translation);
  return translation;
}

function fillTranslation(translation: HTMLElement, text: string): void {
  const content = settings.sentenceBreaks ? breakSentences(text) : text;
  if (content !== text) translation.dataset.breaks = "true";
  translation.textContent = content;
  delete translation.dataset.loading;
}

function applyTranslationStyle(): void {
  const translations = Array.from(document.querySelectorAll<HTMLElement>(".fanyi-translation"));
  const position = settings.translationFirst ? "before" : "after";
  translations.forEach((element) => {
    element.dataset.style = settings.translationStyle;
    element.style.setProperty("--fanyi-font-scale", String(settings.fontScale / 100));
    if (element.dataset.loading) element.dataset.loading = settings.loadingStyle;
  });
  // 字号、样式或位置变化后，原本装得下的固定高度原文可能装不下了
  translations.forEach((element) => {
    const source = sourceOf.get(element);
    if (!source) return;
    if (element.dataset.position === position) settleTranslation(source, element);
    else placeTranslation(source, element);
  });
}

function showProgress(text: string): HTMLElement {
  let toast = document.querySelector<HTMLElement>(".fanyi-progress-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "fanyi-progress-toast";
    document.documentElement.append(toast);
  }
  toast.textContent = text;
  return toast;
}

function showNotice(text: string): void {
  const toast = showProgress(text);
  window.setTimeout(() => toast.remove(), 2500);
}

async function sendTranslationRequest(texts: string[], sourceLanguage: string, targetLanguage: string): Promise<string[]> {
  const response = await chrome.runtime.sendMessage({ type: "TRANSLATE_TEXTS", texts, sourceLanguage, targetLanguage } satisfies RuntimeMessage) as TranslationResponse;
  if (!response.ok || !response.translations) throw new Error(response.error || "翻译失败");
  if (response.translations.length !== texts.length) throw new Error("译文数量不一致");
  return response.translations;
}

async function requestTranslations(texts: string[], sourceLanguage: string, targetLanguage: string): Promise<string[]> {
  // 正文、标题、划词都经过这里：超长文本拆段、按段落数和字符数分批，再按原顺序回组
  const pieces = texts.map((text) => splitText(text, settings.maxCharsPerRequest));
  const flat = pieces.flat();
  const translated: string[] = [];
  while (translated.length < flat.length) {
    const window = flat.slice(translated.length, translated.length + settings.maxParagraphsPerRequest);
    const batch = window.slice(0, batchSizeFor(window.map((text) => text.length), settings.maxCharsPerRequest));
    translated.push(...(await sendTranslationRequest(batch, sourceLanguage, targetLanguage)));
  }
  let cursor = 0;
  return pieces.map(({ length }) => translated.slice(cursor, (cursor += length)).join(" "));
}

async function drainQueue(announce: boolean): Promise<void> {
  if (translating || !active || !queue.length) return;
  translating = true;
  const currentGeneration = generation;
  let done = 0;
  const toast = announce ? showProgress(`正在翻译 0 / ${queue.length}`) : null;
  notifyState();

  while (queue.length && active && currentGeneration === generation) {
    const candidates = queue.slice(0, settings.maxParagraphsPerRequest);
    const batch = queue.splice(0, batchSizeFor(candidates.map(({ text }) => text.length), settings.maxCharsPerRequest));
    const placeholders = batch.map(({ element }) => createTranslationElement(element));
    try {
      const translations = await requestTranslations(batch.map(({ text }) => text), settings.sourceLanguage, settings.targetLanguage);
      if (!active || currentGeneration !== generation) break;
      placeholders.forEach((placeholder, index) => fillTranslation(placeholder, translations[index]));
      // 真实译文比占位符长，固定高度的原文可能此时才装不下
      placeholders.forEach((placeholder, index) => settleTranslation(batch[index].element, placeholder));
    } catch (error) {
      // 旧轮次的失败不能碰重启后的新队列和新占位符
      if (!active || currentGeneration !== generation) break;
      const description = error instanceof Error ? error.message : "翻译失败";
      placeholders.forEach((placeholder, index) => {
        placeholder.textContent = index === 0 ? `翻译失败：${description}` : "";
        delete placeholder.dataset.loading;
      });
      // 失败批次保留占位符和处理标记；未发出的段落退回未处理状态等下次扫描
      queue.splice(0).forEach(({ element }) => delete element.dataset.fanyiProcessed);
      break;
    }
    done += batch.length;
    if (toast) toast.textContent = `正在翻译 ${done} / ${done + queue.length}`;
  }

  if (currentGeneration === generation) translating = false;
  toast?.remove();
  notifyState();
}

async function pageLanguage(sample: string): Promise<string> {
  if (settings.sourceLanguage !== "auto") return settings.sourceLanguage;
  if (document.documentElement.lang) return document.documentElement.lang;
  const detected = await chrome.i18n.detectLanguage(sample);
  return detected.languages[0]?.language ?? "";
}

async function translateTitle(): Promise<void> {
  const title = document.title.trim();
  if (!title || originalTitle !== null) return;
  originalTitle = document.title;
  const currentGeneration = generation;
  try {
    const [translated] = await requestTranslations([title], settings.sourceLanguage, settings.targetLanguage);
    // 网页在此期间自己改了标题就不再覆盖
    if (!active || currentGeneration !== generation || !translated || document.title !== originalTitle) return;
    translatedTitle = `${translated} | ${originalTitle}`;
    document.title = translatedTitle;
  } catch {
    // 标题翻译失败不打断正文，正文批次会把同一错误显示给用户
  }
}

function translatePage(reset: boolean): Promise<PageStateResponse> {
  // 记录进行中的启动，语言检测期间再次 TOGGLE 才能取消它；旧启动结束时不能清掉新启动的记录
  const current: Promise<PageStateResponse> = startTranslation(reset).finally(() => {
    if (startup === current) startup = null;
  });
  startup = current;
  return current;
}

async function startTranslation(reset: boolean): Promise<PageStateResponse> {
  if (!supported) return pageState();
  if (reset) removePageTranslations();
  const starting = reset || !active;
  // 每次启动都换一个代次，仍在等语言检测的更早启动会在检测返回后自行放弃
  if (starting) generation += 1;
  const currentGeneration = generation;
  const paragraphs = collectParagraphs();
  if (starting && settings.detectSameLanguage) {
    const sample = paragraphs.slice(0, 20).map(({ text }) => text).join(" ");
    const language = await pageLanguage(sample);
    if (currentGeneration !== generation) return pageState();
    if (isSameLanguage(language, settings.targetLanguage)) {
      showNotice("页面语言与目标语言相同，无需翻译");
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
  if (starting && settings.translateTitle) void translateTitle();
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  notifyState();
  void drainQueue(true);
  return pageState();
}

function removePageTranslations(): void {
  generation += 1;
  mutationObserver.disconnect();
  visibilityObserver.disconnect();
  waiting.clear();
  queue.length = 0;
  document.querySelectorAll(".fanyi-translation").forEach((element) => element.remove());
  document.querySelectorAll<HTMLElement>("[data-fanyi-processed]").forEach((element) => delete element.dataset.fanyiProcessed);
  document.querySelector(".fanyi-progress-toast")?.remove();
  // 只撤销扩展自己写入的标题，网页后来更新的标题保持不动
  if (originalTitle !== null && document.title === translatedTitle) document.title = originalTitle;
  originalTitle = null;
  translatedTitle = null;
  translating = false;
}

async function togglePage(): Promise<PageStateResponse> {
  if (active || startup) {
    active = false;
    removePageTranslations();
    notifyState();
    return pageState();
  }
  return translatePage(false);
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

async function showSelectionTranslation(text: string, rect?: DOMRect): Promise<void> {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (normalized.length < 2) return;
  selectionHost?.remove();
  selectionButton?.remove();

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
  shadow.querySelector(".close")?.addEventListener("click", () => host.remove());
  shadow.querySelector(".speak-source")?.addEventListener("click", () => speak(normalized, from.value));
  host.addEventListener("pointerdown", (event) => event.stopPropagation());
  positionSelectionHost(host, rect);

  const translate = async (): Promise<void> => {
    const requestId = ++selectionRequest;
    result.className = "result loading";
    result.textContent = "正在理解这段文字";
    copyButton.disabled = true;
    try {
      const [translation] = await requestTranslations([normalized], from.value, to.value);
      if (requestId !== selectionRequest || !host.isConnected) return;
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
  await translate();
}

function showSelectionButton(text: string, rect: DOMRect, point: { x: number; y: number }): void {
  selectionButton?.remove();
  const host = document.createElement("div");
  host.dataset.fanyiRoot = "trigger";
  host.style.left = `${Math.min(point.x + 8, window.innerWidth - 42)}px`;
  host.style.top = `${Math.min(point.y + 12, window.innerHeight - 42)}px`;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>:host { all: initial; position: fixed; z-index: 2147483647; } button { width: 32px; height: 32px; border: 1px solid rgba(32,76,61,.16); border-radius: 9px; color: #153b31; background: #b7e8ce; box-shadow: 0 6px 18px rgba(17,45,36,.22); cursor: pointer; font: 700 15px/1 sans-serif; }</style><button title="翻译选中文本" aria-label="翻译选中文本">译</button>`;
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
  selectionHost?.remove();
  selectionButton?.remove();
  selectionHost = null;
  selectionButton = null;
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_STATE") {
    sendResponse(pageState());
    return false;
  }
  if (message.type === "TOGGLE_PAGE") {
    void togglePage().then(sendResponse);
    return true;
  }
  if (message.type === "RESTART_TRANSLATION") {
    void translatePage(true).then(sendResponse);
    return true;
  }
  if (message.type === "SETTINGS_UPDATED") {
    void getSettings().then((nextSettings) => {
      settings = nextSettings;
      applyTranslationStyle();
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

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "local") return;
  void getSettings().then((nextSettings) => {
    settings = nextSettings;
    supported = !isSiteExcluded(location.hostname, settings.excludedSites);
    applyTranslationStyle();
    if (!supported && active) {
      active = false;
      removePageTranslations();
      notifyState();
    }
  });
});

void getSettings().then((initialSettings) => {
  settings = initialSettings;
  supported = !isSiteExcluded(location.hostname, settings.excludedSites);
  // 开启“立即翻译到页面底部”时进入网页就开始翻译
  if (supported && settings.translateFullPage) void translatePage(false);
});
