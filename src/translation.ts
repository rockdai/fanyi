import { languageName, type Settings } from "./settings";

const translationCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const PARAGRAPH_SEPARATOR = "%%";

export function parseTranslations(content: string, expectedLength: number): string[] {
  // ponytail: 原文本身含 %% 会错位，与沉浸式翻译同样的取舍；真遇到再换转义方案
  const parts = content.trim().split(PARAGRAPH_SEPARATOR).map((part) => part.trim());
  if (parts.length !== expectedLength) throw new Error("AI 返回的译文数量不一致");
  return parts;
}

export function buildTranslationPrompt(targetLanguage: string): string {
  // 模型对 zh-CN/zh-TW 这类代码的理解不稳定，prompt 里用可读的英文语言名
  const to = languageName(targetLanguage);
  return `You are a professional ${to} native translator who needs to fluently translate text into ${to}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains ${PARAGRAPH_SEPARATOR}, use ${PARAGRAPH_SEPARATOR} in your output, if input has no ${PARAGRAPH_SEPARATOR}, don't use ${PARAGRAPH_SEPARATOR} in your output

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use ${PARAGRAPH_SEPARATOR} as paragraph separator between translations

## Examples
### Multi-paragraph Input:
Paragraph A

${PARAGRAPH_SEPARATOR}

Paragraph B

${PARAGRAPH_SEPARATOR}

Paragraph C

${PARAGRAPH_SEPARATOR}

Paragraph D

### Multi-paragraph Output:
Translation A

${PARAGRAPH_SEPARATOR}

Translation B

${PARAGRAPH_SEPARATOR}

Translation C

${PARAGRAPH_SEPARATOR}

Translation D

### Single paragraph Input:
Single paragraph content

### Single paragraph Output:
Direct translation without separators`;
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
  const userContent = texts.join(`\n\n${PARAGRAPH_SEPARATOR}\n\n`);
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
        { role: "system", content: buildTranslationPrompt(settings.targetLanguage) },
        { role: "user", content: userContent },
      ],
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) throw new Error(payload.error?.message || `AI 服务请求失败（${response.status}）`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 服务未返回译文");
  return parseTranslations(content, texts.length);
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
