import type { RuntimeMessage, TranslationResponse } from "./messages";
import { getSettings } from "./settings";
import { translateTexts } from "./translation";

const MENU_ID = "fanyi-translate-selection";

function createContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "使用 fanyi 翻译“%s”",
      contexts: ["selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText || !tab?.id) return;
  void chrome.tabs.sendMessage(tab.id, { type: "SHOW_SELECTION_TRANSLATION", text: info.selectionText } satisfies RuntimeMessage);
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
    }
  })();
  return true;
});
