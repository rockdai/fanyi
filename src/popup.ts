import type { PageStateResponse, RuntimeMessage } from "./messages";
import { getSettings, saveSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES, type Settings, type TranslationProvider } from "./settings";

const translateButton = document.querySelector<HTMLButtonElement>("#translate-page")!;
const selectionToggle = document.querySelector<HTMLInputElement>("#selection-enabled")!;
const sourceSelect = document.querySelector<HTMLSelectElement>("#source-language")!;
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language")!;
const providerSelect = document.querySelector<HTMLSelectElement>("#provider")!;
const providerHint = document.querySelector<HTMLElement>("#provider-hint")!;

let settings: Settings;
let activeTab: chrome.tabs.Tab | undefined;
let pageState: PageStateResponse = { enabled: false, active: false, translating: false, supported: false, translatedCount: 0 };

function fillLanguages(): void {
  sourceSelect.replaceChildren(...SOURCE_LANGUAGES.map(({ code, label }) => new Option(label, code)));
  targetSelect.replaceChildren(...TARGET_LANGUAGES.map(({ code, label }) => new Option(label, code)));
}

function sendToTab<T>(message: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!activeTab?.id) {
      reject(new Error("当前页面不可用"));
      return;
    }
    chrome.tabs.sendMessage(activeTab.id, message, (response: T) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function renderSettings(): void {
  selectionToggle.checked = settings.selectionEnabled;
  sourceSelect.value = settings.sourceLanguage;
  targetSelect.value = settings.targetLanguage;
  providerSelect.value = settings.provider;
  providerHint.hidden = settings.provider !== "openai" || Boolean(settings.apiKey.trim());
}

function renderPageState(): void {
  // 按钮跟随全局开关，本页因为语言相同而没有译文时也能从这里关掉翻译
  translateButton.setAttribute("aria-pressed", String(pageState.enabled));
  translateButton.disabled = !pageState.supported;
  translateButton.textContent = !pageState.supported ? "当前页面不可用" : pageState.enabled ? "显示原文" : "翻译";
}

async function updateSetting(patch: Partial<Settings>, restart = false): Promise<void> {
  settings = await saveSettings(patch);
  renderSettings();
  if (!pageState.supported) return;
  // 开关开着就重新评估当前页，本页可能因为之前的目标语言相同而没有译文
  const message: RuntimeMessage = { type: restart && pageState.enabled ? "RESTART_TRANSLATION" : "SETTINGS_UPDATED" };
  pageState = await sendToTab<PageStateResponse>(message).catch(() => pageState);
  renderPageState();
}

translateButton.addEventListener("click", async () => {
  translateButton.textContent = pageState.enabled ? "正在恢复原文" : "正在分析正文";
  try {
    pageState = await sendToTab<PageStateResponse>({ type: "TOGGLE_PAGE" });
  } catch {
    pageState.supported = false;
  }
  renderPageState();
});

// 翻译完成或从快捷键、右键菜单开关时内容脚本都会广播状态，弹窗据此刷新而不必重新打开
chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender) => {
  if (message.type !== "PAGE_STATE_CHANGED" || !activeTab || sender.tab?.id !== activeTab.id) return;
  pageState = message.state;
  renderPageState();
});

selectionToggle.addEventListener("change", () => void updateSetting({ selectionEnabled: selectionToggle.checked }));
sourceSelect.addEventListener("change", () => void updateSetting({ sourceLanguage: sourceSelect.value }, true));
targetSelect.addEventListener("change", () => void updateSetting({ targetLanguage: targetSelect.value }, true));
providerSelect.addEventListener("change", () => void updateSetting({ provider: providerSelect.value as TranslationProvider }, true));

document.querySelector("#swap-languages")?.addEventListener("click", () => {
  const currentSource = settings.sourceLanguage;
  const nextSource = settings.targetLanguage;
  const nextTarget = currentSource === "auto" ? "en" : currentSource;
  void updateSetting({ sourceLanguage: nextSource, targetLanguage: nextTarget }, true);
});

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}

document.querySelector("#open-key-settings")?.addEventListener("click", openOptions);
document.querySelector("#open-options")?.addEventListener("click", openOptions);

async function initialize(): Promise<void> {
  fillLanguages();
  settings = await getSettings();
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    pageState = await sendToTab<PageStateResponse>({ type: "GET_PAGE_STATE" });
  } catch {
    pageState = { enabled: false, active: false, translating: false, supported: false, translatedCount: 0 };
  }
  renderSettings();
  renderPageState();
}

void initialize();
