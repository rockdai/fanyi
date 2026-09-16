import type { Settings } from "./settings";

const translationCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export function parseTranslationArray(content: string, expectedLength: number): string[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket < 0 || lastBracket <= firstBracket) {
    throw new Error("AI 返回格式不正确");
  }

  const parsed: unknown = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed) || parsed.length !== expectedLength || !parsed.every((item) => typeof item === "string")) {
    throw new Error("AI 返回的译文数量不一致");
  }
  return parsed;
}

function remember(key: string, value: string): void {
  if (translationCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = translationCache.keys().next().value as string | undefined;
    if (oldestKey) translationCache.delete(oldestKey);
  }
  translationCache.set(key, value);
}

async function translateWithGoogle(text: string, sourceLanguage: string, targetLanguage: string): Promise<string> {
  const query = new URLSearchParams({
    client: "gtx",
    sl: sourceLanguage,
    tl: targetLanguage,
    dt: "t",
    q: text,
  });
  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${query.toString()}`);
  if (!response.ok) throw new Error(`Google 翻译请求失败（${response.status}）`);

  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) throw new Error("Google 翻译返回格式异常");
  const translated = payload[0]
    .filter((part): part is unknown[] => Array.isArray(part))
    .map((part) => String(part[0] ?? ""))
    .join("");
  if (!translated) throw new Error("未获得译文");
  return translated;
}

async function translateWithOpenAI(texts: string[], settings: Settings): Promise<string[]> {
  if (!settings.apiKey.trim()) throw new Error("请先在设置中填写 API Key");
  const endpoint = `${settings.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const targetLabel = settings.targetLanguage;
  const numberedTexts = texts.map((text, index) => `${index + 1}. ${text}`).join("\n\n");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.apiModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are a precise translation engine. Translate every numbered item into ${targetLabel}. Preserve meaning, tone, names, inline punctuation, and formatting. Return only a valid JSON array of translated strings in the original order. The array must contain exactly ${texts.length} strings.`,
        },
        { role: "user", content: numberedTexts },
      ],
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) throw new Error(payload.error?.message || `AI 服务请求失败（${response.status}）`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 服务未返回译文");
  return parseTranslationArray(content, texts.length);
}

export async function translateTexts(texts: string[], settings: Settings, sourceLanguage: string, targetLanguage: string): Promise<string[]> {
  const normalizedTexts = texts.map((text) => text.trim().slice(0, 5000));
  const results = new Array<string>(texts.length);
  const missing: Array<{ index: number; text: string; key: string }> = [];

  normalizedTexts.forEach((text, index) => {
    const key = `${settings.provider}:${sourceLanguage}:${targetLanguage}:${text}`;
    const cached = translationCache.get(key);
    if (cached) results[index] = cached;
    else missing.push({ index, text, key });
  });

  if (!missing.length) return results;

  if (settings.provider === "openai") {
    const translations = await translateWithOpenAI(missing.map(({ text }) => text), { ...settings, sourceLanguage, targetLanguage });
    translations.forEach((translation, offset) => {
      const item = missing[offset];
      results[item.index] = translation;
      remember(item.key, translation);
    });
    return results;
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (cursor < missing.length) {
      const item = missing[cursor++];
      const translation = await translateWithGoogle(item.text, sourceLanguage, targetLanguage);
      results[item.index] = translation;
      remember(item.key, translation);
    }
  });
  await Promise.all(workers);
  return results;
}
