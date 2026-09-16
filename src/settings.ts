export type TranslationProvider = "google" | "openai";
export type TranslationStyle = "soft" | "underline" | "card";

export interface Settings {
  selectionEnabled: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  provider: TranslationProvider;
  translationStyle: TranslationStyle;
  fontScale: number;
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
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
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  provider: "google",
  translationStyle: "soft",
  fontScale: 95,
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  apiModel: "gpt-4o-mini",
  excludedSites: [],
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set(next);
  return next;
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
