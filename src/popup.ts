import type { PageStateResponse, RuntimeMessage } from "./messages";
import { getSettings, saveSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES, type Settings, type TranslationStyle } from "./settings";

const pageStatus = document.querySelector<HTMLElement>("#page-status")!;
const pageTitle = document.querySelector<HTMLElement>("#page-title")!;
const pageHost = document.querySelector<HTMLElement>("#page-host")!;
const statusCard = document.querySelector<HTMLElement>("#status-card")!;
const translateButton = document.querySelector<HTMLButtonElement>("#translate-page")!;
const selectionToggle = document.querySelector<HTMLInputElement>("#selection-enabled")!;
const sourceSelect = document.querySelector<HTMLSelectElement>("#source-language")!;
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language")!;
const engineBadge = document.querySelector<HTMLElement>("#engine-badge")!;
const styleButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-style]"));

let settings: Settings;
let activeTab: chrome.tabs.Tab | undefined;
let pageState: PageStateResponse = { active: false, translating: false, supported: false, translatedCount: 0 };

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
  engineBadge.textContent = settings.provider === "google" ? "Google" : settings.apiModel || "OpenAI";
  styleButtons.forEach((button) => {
    const selected = button.dataset.style === settings.translationStyle;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
}

function renderPageState(): void {
  const hostname = activeTab?.url ? new URL(activeTab.url).hostname : "";
  pageHost.textContent = hostname || "保留原文，逐段生成自然译文";
  translateButton.setAttribute("aria-pressed", String(pageState.active));
  translateButton.disabled = !pageState.supported || pageState.translating;
  statusCard.classList.toggle("active", pageState.active);

  if (!pageState.supported) {
    pageStatus.textContent = "当前页面不可用";
    pageTitle.textContent = "换个网页试试";
    pageHost.textContent = "浏览器内部页面或排除网站无法注入插件";
  } else if (pageState.translating) {
    pageStatus.textContent = "翻译进行中";
    pageTitle.textContent = "正在读懂这篇内容";
  } else if (pageState.active) {
    pageStatus.textContent = "沉浸翻译已开启";
    pageTitle.textContent = pageState.translatedCount ? `已翻译 ${pageState.translatedCount} 个段落` : "等待页面内容";
  } else {
    pageStatus.textContent = "准备就绪";
    pageTitle.textContent = "翻译当前网页";
  }
}

async function updateSetting(patch: Partial<Settings>, restart = false): Promise<void> {
  settings = await saveSettings(patch);
  renderSettings();
  if (!pageState.supported) return;
  const message: RuntimeMessage = { type: restart && pageState.active ? "RESTART_TRANSLATION" : "SETTINGS_UPDATED" };
  pageState = await sendToTab<PageStateResponse>(message).catch(() => pageState);
  renderPageState();
}

translateButton.addEventListener("click", async () => {
  translateButton.disabled = true;
  pageStatus.textContent = pageState.active ? "正在恢复原文" : "正在分析正文";
  try {
    pageState = await sendToTab<PageStateResponse>({ type: "TOGGLE_PAGE" });
  } catch {
    pageState.supported = false;
  }
  renderPageState();
});

selectionToggle.addEventListener("change", () => void updateSetting({ selectionEnabled: selectionToggle.checked }));
sourceSelect.addEventListener("change", () => void updateSetting({ sourceLanguage: sourceSelect.value }, true));
targetSelect.addEventListener("change", () => void updateSetting({ targetLanguage: targetSelect.value }, true));

document.querySelector("#swap-languages")?.addEventListener("click", () => {
  const currentSource = settings.sourceLanguage;
  const nextSource = settings.targetLanguage;
  const nextTarget = currentSource === "auto" ? "en" : currentSource;
  void updateSetting({ sourceLanguage: nextSource, targetLanguage: nextTarget }, true);
});

styleButtons.forEach((button) => {
  button.addEventListener("click", () => void updateSetting({ translationStyle: button.dataset.style as TranslationStyle }));
});

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}

document.querySelector("#open-settings")?.addEventListener("click", openOptions);
document.querySelector("#open-options")?.addEventListener("click", openOptions);

async function initialize(): Promise<void> {
  fillLanguages();
  settings = await getSettings();
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.title) pageTitle.textContent = activeTab.title;
  try {
    pageState = await sendToTab<PageStateResponse>({ type: "GET_PAGE_STATE" });
  } catch {
    pageState = { active: false, translating: false, supported: false, translatedCount: 0 };
  }
  renderSettings();
  renderPageState();
}

void initialize();
