import type { RuntimeMessage, TranslationResponse } from "./messages";
import { DEFAULT_SETTINGS, getSettings, saveSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES, type Settings, type TranslationProvider, type TranslationStyle } from "./settings";

const sectionMeta: Record<string, { title: string; description: string }> = {
  general: { title: "通用设置", description: "设置默认语言与翻译行为。" },
  service: { title: "翻译服务", description: "选择免费引擎或连接自己的 AI 服务。" },
  appearance: { title: "阅读样式", description: "让译文自然融入不同网页。" },
  sites: { title: "网站管理", description: "控制 fanyi 在哪些网站运行。" },
  privacy: { title: "隐私说明", description: "了解文本和密钥如何被处理。" },
};

const sourceSelect = document.querySelector<HTMLSelectElement>("#options-source-language")!;
const targetSelect = document.querySelector<HTMLSelectElement>("#options-target-language")!;
const selectionToggle = document.querySelector<HTMLInputElement>("#options-selection-enabled")!;
const apiBaseUrl = document.querySelector<HTMLInputElement>("#api-base-url")!;
const apiKey = document.querySelector<HTMLInputElement>("#api-key")!;
const apiModel = document.querySelector<HTMLInputElement>("#api-model")!;
const fontScale = document.querySelector<HTMLInputElement>("#font-scale")!;
const fontScaleOutput = document.querySelector<HTMLOutputElement>("#font-scale-output")!;
const excludedSites = document.querySelector<HTMLTextAreaElement>("#excluded-sites")!;
const saveState = document.querySelector<HTMLElement>("#save-state")!;
const openAISettings = document.querySelector<HTMLElement>("#openai-settings")!;
const testButton = document.querySelector<HTMLButtonElement>("#test-provider")!;
const testResult = document.querySelector<HTMLElement>("#test-result")!;
const toast = document.querySelector<HTMLElement>("#toast")!;

let settings: Settings;
let ready = false;
let saveTimer: number | undefined;
let toastTimer: number | undefined;

function fillLanguages(): void {
  sourceSelect.replaceChildren(...SOURCE_LANGUAGES.map(({ code, label }) => new Option(label, code)));
  targetSelect.replaceChildren(...TARGET_LANGUAGES.map(({ code, label }) => new Option(label, code)));
}

function render(): void {
  sourceSelect.value = settings.sourceLanguage;
  targetSelect.value = settings.targetLanguage;
  selectionToggle.checked = settings.selectionEnabled;
  apiBaseUrl.value = settings.apiBaseUrl;
  apiKey.value = settings.apiKey;
  apiModel.value = settings.apiModel;
  fontScale.value = String(settings.fontScale);
  fontScaleOutput.value = `${settings.fontScale}%`;
  excludedSites.value = settings.excludedSites.join("\n");
  document.querySelectorAll<HTMLInputElement>("input[name='provider']").forEach((input) => input.checked = input.value === settings.provider);
  document.querySelectorAll<HTMLInputElement>("input[name='translation-style']").forEach((input) => input.checked = input.value === settings.translationStyle);
  openAISettings.style.display = settings.provider === "openai" ? "block" : "none";
}

function flashSaved(): void {
  saveState.classList.add("visible");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveState.classList.remove("visible"), 1500);
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2200);
}

async function persist(patch: Partial<Settings>): Promise<void> {
  if (!ready) return;
  settings = await saveSettings(patch);
  render();
  flashSaved();
}

document.querySelectorAll<HTMLButtonElement>("nav button[data-section]").forEach((button) => {
  button.addEventListener("click", () => {
    const section = button.dataset.section!;
    document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".settings-section").forEach((item) => item.classList.toggle("active", item.id === section));
    document.querySelector<HTMLElement>("#section-title")!.textContent = sectionMeta[section].title;
    document.querySelector<HTMLElement>("#section-description")!.textContent = sectionMeta[section].description;
    history.replaceState(null, "", `#${section}`);
  });
});

sourceSelect.addEventListener("change", () => void persist({ sourceLanguage: sourceSelect.value }));
targetSelect.addEventListener("change", () => void persist({ targetLanguage: targetSelect.value }));
selectionToggle.addEventListener("change", () => void persist({ selectionEnabled: selectionToggle.checked }));
apiBaseUrl.addEventListener("change", () => void persist({ apiBaseUrl: apiBaseUrl.value.trim() }));
apiKey.addEventListener("change", () => void persist({ apiKey: apiKey.value.trim() }));
apiModel.addEventListener("change", () => void persist({ apiModel: apiModel.value.trim() }));
excludedSites.addEventListener("change", () => void persist({ excludedSites: excludedSites.value.split("\n").map((site) => site.trim()).filter(Boolean) }));
fontScale.addEventListener("input", () => {
  fontScaleOutput.value = `${fontScale.value}%`;
});
fontScale.addEventListener("change", () => void persist({ fontScale: Number(fontScale.value) }));

document.querySelectorAll<HTMLInputElement>("input[name='provider']").forEach((input) => {
  input.addEventListener("change", () => void persist({ provider: input.value as TranslationProvider }));
});

document.querySelectorAll<HTMLInputElement>("input[name='translation-style']").forEach((input) => {
  input.addEventListener("change", () => void persist({ translationStyle: input.value as TranslationStyle }));
});

document.querySelector("#toggle-api-key")?.addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  apiKey.type = apiKey.type === "password" ? "text" : "password";
  button.textContent = apiKey.type === "password" ? "显示" : "隐藏";
});

function requestApiPermission(): Promise<boolean> {
  if (settings.provider !== "openai") return Promise.resolve(true);
  try {
    const origin = `${new URL(settings.apiBaseUrl).origin}/*`;
    return chrome.permissions.request({ origins: [origin] });
  } catch {
    return Promise.resolve(false);
  }
}

testButton.addEventListener("click", async () => {
  settings = { ...settings, apiBaseUrl: apiBaseUrl.value.trim(), apiKey: apiKey.value.trim(), apiModel: apiModel.value.trim() };
  const permissionRequest = requestApiPermission();
  await persist({ apiBaseUrl: apiBaseUrl.value.trim(), apiKey: apiKey.value.trim(), apiModel: apiModel.value.trim() });
  testButton.disabled = true;
  testResult.textContent = "正在连接…";
  const hasPermission = await permissionRequest;
  if (!hasPermission) {
    testResult.textContent = "未获得该接口的访问权限";
    testButton.disabled = false;
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_PROVIDER" } satisfies RuntimeMessage) as TranslationResponse;
    testResult.textContent = response.ok ? `连接成功：${response.translations?.[0] ?? ""}` : response.error ?? "连接失败";
  } catch {
    testResult.textContent = "连接失败，请检查接口配置";
  }
  testButton.disabled = false;
});

document.querySelector("#reset-settings")?.addEventListener("click", async () => {
  if (!confirm("确定恢复所有默认设置？API Key 也会被清除。")) return;
  await chrome.storage.local.clear();
  settings = { ...DEFAULT_SETTINGS };
  render();
  showToast("已恢复默认设置");
});

async function initialize(): Promise<void> {
  fillLanguages();
  settings = await getSettings();
  render();
  ready = true;
  const initialSection = location.hash.slice(1);
  if (sectionMeta[initialSection]) document.querySelector<HTMLButtonElement>(`button[data-section='${initialSection}']`)?.click();
}

void initialize();
