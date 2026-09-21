import { TRANSLATE_PORT, type RuntimeMessage, type TestProviderMessage, type TranslateTextsMessage, type TranslationResponse } from "./messages";
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
  // 内容脚本在每个框架都有一份：开关只发给顶层框架，划词发给右键点中的那个框架
  if (info.menuItemId === PAGE_MENU_ID) void chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAGE" } satisfies RuntimeMessage, { frameId: 0 }).catch(() => undefined);
  if (info.menuItemId === SELECTION_MENU_ID && info.selectionText) void chrome.tabs.sendMessage(tab.id, { type: "SHOW_SELECTION_TRANSLATION", text: info.selectionText } satisfies RuntimeMessage, { frameId: info.frameId ?? 0 });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const type = command === "toggle-page-translation" ? "TOGGLE_PAGE" : "TRANSLATE_CURRENT_SELECTION";
  // 翻译选中文本要广播：选区在哪个框架只有该框架自己知道
  const options = type === "TOGGLE_PAGE" ? { frameId: 0 } : {};
  await chrome.tabs.sendMessage(tab.id, { type } satisfies RuntimeMessage, options).catch(() => undefined);
});

async function translate(message: TranslateTextsMessage | TestProviderMessage, signal?: AbortSignal): Promise<TranslationResponse> {
  holdWorker();
  try {
    const settings = await getSettings();
    const texts = message.type === "TEST_PROVIDER" ? ["The world is full of things worth understanding."] : message.texts;
    const sourceLanguage = message.type === "TEST_PROVIDER" ? "en" : message.sourceLanguage;
    const targetLanguage = message.type === "TEST_PROVIDER" ? settings.targetLanguage : message.targetLanguage;
    const translations = await translateTexts(texts, settings, sourceLanguage, targetLanguage, signal);
    return { ok: true, translations };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "翻译失败，请稍后重试" };
  } finally {
    releaseWorker();
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "PAGE_STATE_CHANGED") {
    if (sender.tab?.id) {
      void chrome.action.setBadgeText({ tabId: sender.tab.id, text: message.state.active ? "ON" : "" });
      void chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#2f775e" });
    }
    return false;
  }
  if (message.type !== "TEST_PROVIDER") return false;
  void translate(message).then(sendResponse);
  return true;
});

// 页面翻译走长连接：内容脚本停止或重启时断开端口，后台随之中止未完成的请求和重试
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TRANSLATE_PORT) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: RuntimeMessage) => {
    if (message.type !== "TRANSLATE_TEXTS") return;
    void translate(message, controller.signal).then((response) => {
      if (!controller.signal.aborted) port.postMessage(response);
    });
  });
});
