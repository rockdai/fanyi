export type TranslationProvider = "google" | "openai";
export type TranslationStyle = "soft" | "underline" | "card";
export type SelectionTrigger = "auto" | "button";
export type LoadingStyle = "spinner" | "none";

export interface Settings {
  selectionEnabled: boolean;
  selectionTrigger: SelectionTrigger;
  selectionSourceLanguage: string;
  selectionTargetLanguage: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: TranslationProvider;
  translationStyle: TranslationStyle;
  fontScale: number;
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
  temperature: number;
  maxParagraphsPerRequest: number;
  maxCharsPerRequest: number;
  minParagraphLength: number;
  eagerCharacters: number;
  translateFullPage: boolean;
  detectSameLanguage: boolean;
  contextMenuEnabled: boolean;
  translateAllAreas: boolean;
  translateAside: boolean;
  translateTitle: boolean;
  translationFirst: boolean;
  sentenceBreaks: boolean;
  loadingStyle: LoadingStyle;
  excludedSites: string[];
}

export interface LanguageOption {
  code: string;
  label: string;
}

export const SOURCE_LANGUAGES: LanguageOption[] = [
  { code: "auto", label: "自动识别" },
  { code: "en", label: "英语" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁体中文" },
  { code: "ja", label: "日语" },
  { code: "ko", label: "韩语" },
  { code: "fr", label: "法语" },
  { code: "de", label: "德语" },
  { code: "es", label: "西班牙语" },
  { code: "ru", label: "俄语" },
  { code: "ar", label: "阿拉伯语" },
];

export const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter(({ code }) => code !== "auto");

export const DEFAULT_SETTINGS: Settings = {
  selectionEnabled: true,
  selectionTrigger: "auto",
  selectionSourceLanguage: "auto",
  selectionTargetLanguage: "zh-CN",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  provider: "google",
  translationStyle: "soft",
  fontScale: 95,
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  apiModel: "gpt-4o-mini",
  temperature: 1,
  maxParagraphsPerRequest: 4,
  maxCharsPerRequest: 2000,
  minParagraphLength: 2,
  eagerCharacters: 4999,
  translateFullPage: false,
  detectSameLanguage: true,
  contextMenuEnabled: true,
  translateAllAreas: false,
  translateAside: true,
  translateTitle: true,
  translationFirst: false,
  sentenceBreaks: false,
  loadingStyle: "spinner",
  excludedSites: [],
};

export function mergeSettings(stored: Partial<Settings>): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // 划词语言未单独设置过时沿用默认语言，老用户升级后划词不会突然换语言
  settings.selectionSourceLanguage = stored.selectionSourceLanguage ?? settings.sourceLanguage;
  settings.selectionTargetLanguage = stored.selectionTargetLanguage ?? settings.targetLanguage;
  return settings;
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get<Partial<Settings>>(null);
  return mergeSettings(stored);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  await chrome.storage.local.set(patch);
  return getSettings();
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^\*\./, "").split("/")[0].replace(/:\d+$/, "");
}

export function isSiteExcluded(hostname: string, sites: string[]): boolean {
  const current = hostname.toLowerCase();
  return sites.some((site) => {
    const domain = normalizeDomain(site);
    return Boolean(domain) && (current === domain || current.endsWith(`.${domain}`));
  });
}

function languageKey(code: string): string {
  const [primary = "", ...rest] = code.trim().toLowerCase().split(/[-_]/);
  if (primary !== "zh") return primary;
  return /^(tw|hk|mo|hant)/.test(rest.join("-")) ? "zh-hant" : "zh-hans";
}

export function isSameLanguage(pageLanguage: string, targetLanguage: string): boolean {
  return Boolean(pageLanguage.trim()) && languageKey(pageLanguage) === languageKey(targetLanguage);
}
