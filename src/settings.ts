export type TranslationProvider = "google" | "openai";
export type TranslationStyle = "soft" | "underline" | "card" | "in-place";
export type SelectionTrigger = "auto" | "button";
export type LoadingStyle = "spinner" | "none";
export type ApiVendor = "none" | "openai" | "deepseek" | "kimi" | "zhipu" | "qwen" | "gemini" | "openrouter" | "vllm";

export interface Settings {
  pageTranslationEnabled: boolean;
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
  apiVendor: ApiVendor;
  temperature: number;
  extraBody: string;
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
  english: string;
}

export const SOURCE_LANGUAGES: LanguageOption[] = [
  { code: "auto", label: "自动识别", english: "Auto" },
  { code: "en", label: "英语", english: "English" },
  { code: "zh-CN", label: "简体中文", english: "Simplified Chinese" },
  { code: "zh-TW", label: "繁体中文", english: "Traditional Chinese" },
  { code: "ja", label: "日语", english: "Japanese" },
  { code: "ko", label: "韩语", english: "Korean" },
  { code: "fr", label: "法语", english: "French" },
  { code: "de", label: "德语", english: "German" },
  { code: "es", label: "西班牙语", english: "Spanish" },
  { code: "ru", label: "俄语", english: "Russian" },
  { code: "ar", label: "阿拉伯语", english: "Arabic" },
];

export const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter(({ code }) => code !== "auto");

export function languageName(code: string): string {
  return SOURCE_LANGUAGES.find((language) => language.code === code)?.english ?? code;
}

export const DEFAULT_SETTINGS: Settings = {
  pageTranslationEnabled: false,
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
  apiVendor: "none",
  temperature: 1,
  extraBody: "",
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

// 语言检测只能给出笼统的 zh，用两种写法各自独有的常用字判断简繁
const SIMPLIFIED_ONLY = "们这个说会时来国学对开关点为过发实应让经导产语译读觉电车马书见长门问间东华难风飞义习写号员图处广汉节乐两满农钱权认岁条网务现样业医银优远运战证转装资总讲论该还边变记设话谁请谢试识词军队联独";
const TRADITIONAL_ONLY = "們這個說會時來國學對開關點為過發實應讓經導產語譯讀覺電車馬書見長門問間東華難風飛義習寫號員圖處廣漢節樂兩滿農錢權認歲條網務現樣業醫銀優遠運戰證轉裝資總講論該還邊變記設話誰請謝試識詞軍隊聯獨";

export function chineseScript(text: string): string | undefined {
  let simplified = 0;
  let traditional = 0;
  for (const character of text) {
    if (SIMPLIFIED_ONLY.includes(character)) simplified += 1;
    if (TRADITIONAL_ONLY.includes(character)) traditional += 1;
  }
  if (simplified === traditional) return undefined;
  return simplified > traditional ? "zh-Hans" : "zh-Hant";
}

function languageKey(code: string): string {
  const [primary = "", ...rest] = code.trim().toLowerCase().split(/[-_]/);
  if (primary !== "zh") return primary;
  return /^(tw|hk|mo|hant)/.test(rest.join("-")) ? "zh-hant" : "zh-hans";
}

export function isSameLanguage(pageLanguage: string, targetLanguage: string): boolean {
  return Boolean(pageLanguage.trim()) && languageKey(pageLanguage) === languageKey(targetLanguage);
}
