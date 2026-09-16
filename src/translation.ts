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

const GOOGLE_RETRIES = 2;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after") ?? "";
  // Retry-After 可以是延迟秒数或 HTTP-date（RFC 9110 §10.2.3），缺失或无效时才用指数退避
  const seconds = Number(header);
  if (header && Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const until = Date.parse(header);
  if (Number.isFinite(until)) return Math.max(0, until - Date.now());
  return 1000 * 2 ** attempt;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    // 429/5xx 多为限流或瞬时故障，按 Retry-After 或指数退避重试，避免整批直接失败
    if ((response.status !== 429 && response.status < 500) || attempt >= GOOGLE_RETRIES) return response;
    await sleep(retryDelay(response, attempt));
  }
}

async function translateWithGoogle(texts: string[], sourceLanguage: string, targetLanguage: string): Promise<string[]> {
  const query = new URLSearchParams({ client: "gtx", sl: sourceLanguage, tl: targetLanguage });
  // translate_a/t 接受多个 q，整批段落只发一次请求；正文放在 POST body 里不受 URL 长度限制
  const body = new URLSearchParams(texts.map((text) => ["q", text]));
  const response = await fetchWithRetry(`https://translate.googleapis.com/translate_a/t?${query.toString()}`, { method: "POST", body });
  if (!response.ok) throw new Error(`Google 翻译请求失败（${response.status}）`);

  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || payload.length !== texts.length) throw new Error("Google 翻译返回格式异常");
  // 源语言为 auto 时每项是 [译文, 检测到的语言]，否则直接是译文字符串
  const translations = payload.map((item: unknown) => (Array.isArray(item) ? item[0] : item));
  if (!translations.every((item): item is string => typeof item === "string" && item.length > 0)) throw new Error("未获得译文");
  return translations;
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
      temperature: settings.temperature,
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

  const pendingTexts = missing.map(({ text }) => text);
  const translations = settings.provider === "openai"
    ? await translateWithOpenAI(pendingTexts, { ...settings, sourceLanguage, targetLanguage })
    : await translateWithGoogle(pendingTexts, sourceLanguage, targetLanguage);
  translations.forEach((translation, offset) => {
    const item = missing[offset];
    results[item.index] = translation;
    remember(item.key, translation);
  });
  return results;
}
