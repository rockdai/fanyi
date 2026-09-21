import { isSameLanguage, languageName, type ApiVendor, type Settings } from "./settings";

const translationCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const PARAGRAPH_SEPARATOR = "%%";
// 协议里的分隔符独占一行；原文经空白折叠后没有换行，正文内联的 %% 不会被当成边界
const SEPARATOR_LINE = /^[ \t]*%%[ \t]*$/m;

export function parseTranslations(content: string, texts: string[]): string[] {
  // 兼容服务可能把整份回复包进代码围栏；原文本身以围栏开头时分不清包装和内容，宁可保留不删
  const trimmed = content.trim();
  const sourceStartsWithFence = texts[0]?.startsWith("```") ?? false;
  const body = sourceStartsWithFence ? trimmed : trimmed.replace(/^```[^\n]*\n([\s\S]*)\n```$/, "$1");
  // 单段模式模型直接输出，不按分隔符拆分
  const parts = texts.length === 1 ? [body] : body.split(SEPARATOR_LINE);
  const translations = parts.map((part) => part.trim());
  if (translations.length !== texts.length) throw new Error("AI 返回的译文数量不一致");
  if (translations.some((translation) => !translation)) throw new Error("AI 服务未返回译文");
  return translations;
}

export function buildSystemPrompt(targetLanguage: string): string {
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

const RETRIES = 2;
// Chrome 会在 fetch 响应头 30 秒未到时直接终止扩展 Service Worker；响应头、JSON 正文和每个流式分片都按同一阈值主动中止，才有机会重试而不是被回收
const STALL_TIMEOUT = 30_000;

class RetryableError extends Error {}
class StreamRejectedError extends Error {}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // 取消要能立刻结束退避等待，否则长 Retry-After 会让已作废的请求一直占着后台
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
  });
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

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("翻译已取消");
}

async function requestWithRetry<T>(url: string, init: RequestInit, read: (response: Response, touch: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfCancelled(signal);
    const controller = new AbortController();
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), STALL_TIMEOUT);
    };
    touch();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      touch();
      // 429/5xx 多为限流或瞬时故障，按 Retry-After 或指数退避重试，避免整批直接失败
      if ((response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        clearTimeout(timer);
        await sleep(retryDelay(response, attempt), signal);
        continue;
      }
      return await read(response, touch);
    } catch (error) {
      throwIfCancelled(signal);
      const stalled = controller.signal.aborted;
      if (!stalled && !(error instanceof TypeError) && !(error instanceof RetryableError)) throw error;
      if (attempt >= RETRIES) throw new Error(stalled ? "服务响应超时" : error instanceof RetryableError ? error.message : "网络请求失败");
      await sleep(1000 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  error?: { message?: string };
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function readCompletion(response: Response, touch: () => void): Promise<string> {
  // 正文读取的超时、取消和网络异常要原样传给重试边界，这里只处理真正的解析失败
  if (!response.ok) {
    const payload = parseJson<OpenAIResponse>(await response.text());
    const message = payload?.error?.message || `AI 服务请求失败（${response.status}）`;
    // 只实现非流式接口的服务会明确拒绝 stream 参数
    throw response.status < 500 && /stream/i.test(message) ? new StreamRejectedError(message) : new Error(message);
  }
  // 服务忽略 stream 参数时会返回整份 JSON
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = parseJson<OpenAIResponse>(await response.text());
    if (!payload) throw new Error("AI 服务返回格式异常");
    return payload.choices?.[0]?.message?.content ?? "";
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    // 没有完成标记就到 EOF 说明流被截断，不能把半截译文当结果
    if (done) {
      if (!finished) throw new RetryableError("AI 服务响应不完整");
      return content;
    }
    touch();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data) continue;
      // 发完 [DONE] 的服务可能不关连接，收到就结束，不等 EOF
      if (data === "[DONE]") {
        void reader.cancel();
        return content;
      }
      const chunk = parseJson<StreamChunk>(data);
      if (!chunk) throw new Error("AI 服务返回格式异常");
      if (chunk.error) throw new Error(chunk.error.message || "AI 服务请求失败");
      const choice = chunk.choices?.[0];
      content += choice?.delta?.content ?? "";
      if (choice?.finish_reason) finished = true;
    }
  }
}

async function translateWithGoogle(texts: string[], sourceLanguage: string, targetLanguage: string, signal?: AbortSignal): Promise<string[]> {
  const query = new URLSearchParams({ client: "gtx", sl: sourceLanguage, tl: targetLanguage });
  // translate_a/t 接受多个 q，整批段落只发一次请求；正文放在 POST body 里不受 URL 长度限制
  const body = new URLSearchParams(texts.map((text) => ["q", text]));
  const payload = await requestWithRetry(`https://translate.googleapis.com/translate_a/t?${query.toString()}`, { method: "POST", body }, (response) => {
    if (!response.ok) throw new Error(`Google 翻译请求失败（${response.status}）`);
    return response.json() as Promise<unknown>;
  }, signal);
  if (!Array.isArray(payload) || payload.length !== texts.length) throw new Error("Google 翻译返回格式异常");
  // 源语言为 auto 时每项是 [译文, 检测到的语言]，否则直接是译文字符串
  const translations = payload.map((item: unknown) => (Array.isArray(item) ? item[0] : item));
  if (!translations.every((item): item is string => typeof item === "string" && item.length > 0)) throw new Error("未获得译文");
  return translations;
}

// 各家关闭思考的参数互不兼容；Kimi 非思考模式温度固定 0.6，其他值会报错
const THINKING_OFF: Record<ApiVendor, Record<string, unknown>> = {
  none: {},
  openai: { reasoning_effort: "none" },
  gemini: { reasoning_effort: "none" },
  deepseek: { thinking: { type: "disabled" } },
  kimi: { thinking: { type: "disabled" }, temperature: 0.6 },
  zhipu: { thinking: { type: "disabled" } },
  qwen: { enable_thinking: false },
  openrouter: { reasoning: { enabled: false } },
  vllm: { chat_template_kwargs: { enable_thinking: false } },
};

function parseExtraBody(extraBody: string): Record<string, unknown> {
  if (!extraBody.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(extraBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  throw new Error("额外请求参数必须是合法的 JSON 对象");
}

export function buildUserPrompt(texts: string[], sourceLanguage: string, targetLanguage: string): string {
  const from = sourceLanguage === "auto" ? "" : ` from ${languageName(sourceLanguage)}`;
  return `Translate${from} to ${languageName(targetLanguage)}: ${texts.join(`\n\n${PARAGRAPH_SEPARATOR}\n\n`)}`;
}

async function translateWithOpenAI(texts: string[], settings: Settings, signal?: AbortSignal): Promise<string[]> {
  if (!settings.apiKey.trim()) throw new Error("请先在设置中填写 API Key");
  const endpoint = `${settings.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const params = { model: settings.apiModel, temperature: settings.temperature, stream: true, ...THINKING_OFF[settings.apiVendor], ...parseExtraBody(settings.extraBody) };
  const messages = [
    { role: "system", content: buildSystemPrompt(settings.targetLanguage) },
    { role: "user", content: buildUserPrompt(texts, settings.sourceLanguage, settings.targetLanguage) },
  ];
  const send = (stream: boolean): Promise<string> => requestWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ ...params, stream, messages }),
  }, readCompletion, signal);

  // 流式返回让响应头立刻到达，长译文不会撞上 Service Worker 的 30 秒限制；额外参数写了 stream:false 就全程不用流式
  const streaming = params.stream !== false;
  let content: string;
  try {
    content = await send(streaming);
  } catch (error) {
    if (!streaming || !(error instanceof StreamRejectedError)) throw error;
    content = await send(false);
  }
  if (!content) throw new Error("AI 服务未返回译文");
  return parseTranslations(content, texts);
}

export async function translateTexts(texts: string[], settings: Settings, sourceLanguage: string, targetLanguage: string, signal?: AbortSignal): Promise<string[]> {
  // 接口配置进缓存键：配置一改旧译文自然失效，旧配置的在途请求晚到也只能写回自己的键
  const apiConfig = settings.provider === "openai" ? JSON.stringify([settings.apiBaseUrl, settings.apiModel, settings.apiVendor, settings.temperature, settings.extraBody]) : "";
  const normalizedTexts = texts.map((text) => text.trim().slice(0, 5000));
  const results = new Array<string>(texts.length);
  const missing: Array<{ index: number; text: string; key: string }> = [];

  normalizedTexts.forEach((text, index) => {
    // 纯数字或符号片段无需翻译；切分后恰好等于 %% 的片段若送出去会与协议分隔符混淆
    if (!/\p{L}/u.test(text) || isSameLanguage(sourceLanguage, targetLanguage)) {
      results[index] = text;
      return;
    }
    const key = `${settings.provider}:${apiConfig}:${sourceLanguage}:${targetLanguage}:${text}`;
    const cached = translationCache.get(key);
    if (cached) results[index] = cached;
    else missing.push({ index, text, key });
  });

  if (!missing.length) return results;

  const pendingTexts = missing.map(({ text }) => text);
  const translations = settings.provider === "openai"
    ? await translateWithOpenAI(pendingTexts, { ...settings, sourceLanguage, targetLanguage }, signal)
    : await translateWithGoogle(pendingTexts, sourceLanguage, targetLanguage, signal);
  translations.forEach((translation, offset) => {
    const item = missing[offset];
    results[item.index] = translation;
    remember(item.key, translation);
  });
  return results;
}
