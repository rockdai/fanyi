import type { PageStateResponse, RuntimeMessage, TranslationResponse } from "./messages";
import { DEFAULT_SETTINGS, getSettings, isSiteExcluded, saveSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES, type LanguageOption, type Settings } from "./settings";

const BLOCK_SELECTOR = "p, li, blockquote, figcaption, h1, h2, h3, h4, h5, h6, td, th, dd";
const SKIP_SELECTOR = "nav, header, footer, aside, script, style, noscript, code, pre, textarea, input, select, button, [contenteditable='true'], [aria-hidden='true'], [data-fanyi-root], .fanyi-translation";
const MAX_PAGE_BLOCKS = 240;
const BATCH_SIZE = 8;
const INHERITED_TEXT_PROPERTIES = ["color", "font-family", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform"];

let settings: Settings = DEFAULT_SETTINGS;
let active = false;
let translating = false;
let supported = true;
let generation = 0;
let mutationTimer: number | undefined;
let selectionTimer: number | undefined;
let selectionRequest = 0;
let selectionHost: HTMLDivElement | null = null;
let selectionButton: HTMLDivElement | null = null;

const mutationObserver = new MutationObserver((mutations) => {
  if (!active || translating) return;
  const hasNewContent = mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => node instanceof HTMLElement && !node.closest(".fanyi-translation, [data-fanyi-root]")));
  if (!hasNewContent) return;
  window.clearTimeout(mutationTimer);
  mutationTimer = window.setTimeout(() => void translatePage(false), 700);
});

function pageState(): PageStateResponse {
  return {
    active,
    translating,
    supported,
    translatedCount: document.querySelectorAll(".fanyi-translation:not([data-loading='true'])").length,
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

function isTranslatable(element: HTMLElement): boolean {
  if (element.hasAttribute("data-fanyi-processed") || element.closest(SKIP_SELECTOR)) return false;
  if (element.querySelector(BLOCK_SELECTOR)) return false;
  if (!isVisible(element)) return false;
  const text = extractText(element);
  if (text.length < 2 || text.length > 5000) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  if (element.children.length > 12) return false;
  return true;
}

export function collectTranslatableElements(root: ParentNode = document): HTMLElement[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  return elements.filter(isTranslatable).slice(0, MAX_PAGE_BLOCKS);
}

function canHoldTranslation(source: HTMLElement, translation: HTMLElement): boolean {
  if (source.matches("td, th")) return true;
  const style = getComputedStyle(source);
  if (/flex|grid|box/.test(style.display) || style.overflowX !== "visible" || style.overflowY !== "visible") return false;
  return translation.getBoundingClientRect().bottom <= source.getBoundingClientRect().bottom + 1;
}

function moveTranslationAfter(source: HTMLElement, translation: HTMLElement): void {
  const style = getComputedStyle(source);
  const copied = [...INHERITED_TEXT_PROPERTIES];
  // 原文自带背景时一并带走，否则复制过来的字色可能与父容器背景撞色
  if (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none") copied.push("background", "padding");
  for (const property of copied) translation.style.setProperty(property, style.getPropertyValue(property), "important");
  translation.style.setProperty("font-size", `calc(${style.fontSize} * var(--fanyi-font-scale, .95))`, "important");
  source.insertAdjacentElement("afterend", translation);
}

function settleTranslation(source: HTMLElement, translation: HTMLElement): void {
  if (translation.parentElement === source && !canHoldTranslation(source, translation)) moveTranslationAfter(source, translation);
}

function createTranslationElement(source: HTMLElement): HTMLDivElement {
  const translation = document.createElement("div");
  translation.className = "fanyi-translation";
  translation.dataset.loading = "true";
  translation.dataset.style = settings.translationStyle;
  translation.style.setProperty("--fanyi-font-scale", String(settings.fontScale / 100));
  source.dataset.fanyiProcessed = "true";
  // 先放进原文内部以继承排版；被裁剪或处于 flex/grid 时外置并复制文字样式
  source.append(translation);
  settleTranslation(source, translation);
  return translation;
}

function applyTranslationStyle(): void {
  const translations = Array.from(document.querySelectorAll<HTMLElement>(".fanyi-translation"));
  translations.forEach((element) => {
    element.dataset.style = settings.translationStyle;
    element.style.setProperty("--fanyi-font-scale", String(settings.fontScale / 100));
  });
  // 字号或样式变化后，原本装得下的固定高度原文可能装不下了
  translations.forEach((element) => {
    const source = element.parentElement;
    if (source?.dataset.fanyiProcessed) settleTranslation(source, element);
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

async function requestTranslations(texts: string[], sourceLanguage: string, targetLanguage: string): Promise<string[]> {
  const response = await chrome.runtime.sendMessage({ type: "TRANSLATE_TEXTS", texts, sourceLanguage, targetLanguage } satisfies RuntimeMessage) as TranslationResponse;
  if (!response.ok || !response.translations) throw new Error(response.error || "翻译失败");
  return response.translations;
}

async function translatePage(reset: boolean): Promise<PageStateResponse> {
  if (!supported) return pageState();
  if (translating) return pageState();
  if (reset) removePageTranslations();

  const elements = collectTranslatableElements();
  if (!elements.length) {
    active = true;
    notifyState();
    return pageState();
  }

  active = true;
  translating = true;
  const currentGeneration = ++generation;
  const toast = showProgress(`正在翻译 0 / ${elements.length}`);
  notifyState();

  for (let offset = 0; offset < elements.length; offset += BATCH_SIZE) {
    if (!active || currentGeneration !== generation) break;
    const batch = elements.slice(offset, offset + BATCH_SIZE);
    const texts = batch.map(extractText);
    const placeholders = batch.map(createTranslationElement);
    try {
      const translations = await requestTranslations(texts, settings.sourceLanguage, settings.targetLanguage);
      if (!active || currentGeneration !== generation) break;
      placeholders.forEach((placeholder, index) => {
        placeholder.textContent = translations[index];
        delete placeholder.dataset.loading;
      });
      // 真实译文比占位符长，固定高度的原文可能此时才装不下
      placeholders.forEach((placeholder, index) => settleTranslation(batch[index], placeholder));
    } catch (error) {
      const description = error instanceof Error ? error.message : "翻译失败";
      placeholders.forEach((placeholder, index) => {
        placeholder.textContent = index === 0 ? `翻译失败：${description}` : "";
        delete placeholder.dataset.loading;
      });
      break;
    }
    toast.textContent = `正在翻译 ${Math.min(offset + BATCH_SIZE, elements.length)} / ${elements.length}`;
  }

  translating = false;
  toast.remove();
  if (active) mutationObserver.observe(document.body, { childList: true, subtree: true });
  notifyState();
  return pageState();
}

function removePageTranslations(): void {
  generation += 1;
  mutationObserver.disconnect();
  document.querySelectorAll(".fanyi-translation").forEach((element) => element.remove());
  document.querySelectorAll<HTMLElement>("[data-fanyi-processed]").forEach((element) => delete element.dataset.fanyiProcessed);
  document.querySelector(".fanyi-progress-toast")?.remove();
  translating = false;
}

async function togglePage(): Promise<PageStateResponse> {
  if (active) {
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
    .card { position: relative; width: 380px; overflow: hidden; border: 1px solid rgba(32,76,61,.16); border-radius: 15px; background: rgba(255,255,255,.98); box-shadow: 0 18px 55px rgba(17,45,36,.22), 0 2px 8px rgba(17,45,36,.08); backdrop-filter: blur(18px); animation: in .16s ease-out; }
    .close { position: absolute; right: 8px; top: 8px; width: 26px; height: 26px; border: 0; border-radius: 7px; color: #81928b; background: transparent; cursor: pointer; font-size: 18px; line-height: 1; }
    .close:hover { background: #edf3ef; color: #355f51; }
    .source { max-height: 110px; padding: 14px 40px 12px 16px; overflow: auto; border-bottom: 1px solid #e9efeb; background: linear-gradient(145deg,#f6fbf8,#fff); color: #64776f; font: 400 14px/1.55 Georgia,"Times New Roman",serif; }
    .result { min-height: 64px; padding: 16px; color: #1f4437; font: 500 16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; white-space: pre-wrap; }
    .result.loading { color: #8ca098; }
    .result.loading::after { content: ""; display: inline-block; width: 4px; height: 4px; margin-left: 5px; border-radius: 50%; background: #4c8b73; box-shadow: 8px 0 #85b9a4, 16px 0 #c0d8ce; animation: dots 1s infinite; }
    .error { color: #a2594d; }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 11px; border-top: 1px solid #edf1ef; background: #fbfcfb; }
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
  if (event.key.startsWith("Arrow") || event.key === "Shift") scheduleSelectionTranslation();
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
    void togglePage();
    sendResponse(pageState());
    return false;
  }
  if (message.type === "RESTART_TRANSLATION") {
    void translatePage(true);
    sendResponse(pageState());
    return false;
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
});
