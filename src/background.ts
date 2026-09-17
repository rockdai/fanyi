import type { RuntimeMessage, TranslationResponse } from "./messages";
import { getSettings } from "./settings";
import { translateTexts } from "./translation";

const SELECTION_MENU_ID = "fanyi-translate-selection";
const PAGE_MENU_ID = "fanyi-toggle-page";

let activeRequests = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;

// Chrome 110 起任何扩展 API 调用都会重置 30 秒空闲计时；等待翻译响应期间定时调用，Service Worker 才不会中途被回收
function holdWorker(): void {
  if (activeRequests++ === 0) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
}

function releaseWorker(): void {
  if (--activeRequests === 0) clearInterval(keepAlive);
}

function syncContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    void getSettings().then(({ contextMenuEnabled }) => {
      if (!contextMenuEnabled) return;
      chrome.contextMenus.create({ id: SELECTION_MENU_ID, title: "使用 fanyi 翻译“%s”", contexts: ["selection"] });
      chrome.contextMenus.create({ id: PAGE_MENU_ID, title: "使用 fanyi 翻译网页", contexts: ["page", "image", "link", "editable"] });
    });
  });
}

chrome.runtime.onInstalled.addListener(syncContextMenu);
chrome.runtime.onStartup.addListener(syncContextMenu);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.contextMenuEnabled) syncContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === PAGE_MENU_ID) void chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAGE" } satisfies RuntimeMessage).catch(() => undefined);
  if (info.menuItemId === SELECTION_MENU_ID && info.selectionText) void chrome.tabs.sendMessage(tab.id, { type: "SHOW_SELECTION_TRANSLATION", text: info.selectionText } satisfies RuntimeMessage);
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const type = command === "toggle-page-translation" ? "TOGGLE_PAGE" : "TRANSLATE_CURRENT_SELECTION";
  await chrome.tabs.sendMessage(tab.id, { type } satisfies RuntimeMessage).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "PAGE_STATE_CHANGED") {
    if (sender.tab?.id) {
      void chrome.action.setBadgeText({ tabId: sender.tab.id, text: message.active ? "ON" : "" });
      void chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#2f775e" });
    }
    return false;
  }

  if (message.type !== "TRANSLATE_TEXTS" && message.type !== "TEST_PROVIDER") return false;

  void (async () => {
    holdWorker();
    try {
      const settings = await getSettings();
      const texts = message.type === "TEST_PROVIDER" ? ["The world is full of things worth understanding."] : message.texts;
      const sourceLanguage = message.type === "TEST_PROVIDER" ? "en" : message.sourceLanguage;
      const targetLanguage = message.type === "TEST_PROVIDER" ? settings.targetLanguage : message.targetLanguage;
      const translations = await translateTexts(texts, settings, sourceLanguage, targetLanguage);
      sendResponse({ ok: true, translations } satisfies TranslationResponse);
    } catch (error) {
      const description = error instanceof Error ? error.message : "翻译失败，请稍后重试";
      sendResponse({ ok: false, error: description } satisfies TranslationResponse);
    } finally {
      releaseWorker();
    }
  })();
  return true;
});
