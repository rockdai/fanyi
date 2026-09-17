import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitText } from "../src/paragraphs";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildSystemPrompt, buildUserPrompt, parseTranslations, translateTexts } from "../src/translation";

describe("AI translation parser", () => {
  const codeA = "```js runA() ```";
  const codeB = "```js runB() ```";

  it("splits multi-paragraph output on the %% separator", () => {
    expect(parseTranslations("你好\n\n%%\n\n世界\n", ["Hello", "World"])).toEqual(["你好", "世界"]);
  });

  it("returns single-paragraph output as is, keeping a literal %%", () => {
    expect(parseTranslations("  用 %% 打印百分号  ", ["Use %% for a percent sign"])).toEqual(["用 %% 打印百分号"]);
  });

  it("splits only on a standalone %% line, so an inline %% stays inside its paragraph", () => {
    expect(parseTranslations("用 %% 打印百分号\n\n%%\n\n第二段", ["Use %% for a percent sign", "Second"])).toEqual(["用 %% 打印百分号", "第二段"]);
    expect(parseTranslations("%% 注释\n\n%%\n\n结尾 %%", ["%% comment", "trailing %%"])).toEqual(["%% 注释", "结尾 %%"]);
  });

  it("strips an outer code fence the model added around plain text", () => {
    expect(parseTranslations("```\n你好\n\n%%\n\n世界\n```", ["Hello", "World"])).toEqual(["你好", "世界"]);
    expect(parseTranslations("```\n介绍\n\n%%\n\n```js\nrunB()\n```\n```", ["Intro", codeB])).toEqual(["介绍", "```js\nrunB()\n```"]);
  });

  it("keeps code fences that belong to the source paragraphs", () => {
    expect(parseTranslations("```js code``` 示例", ["```js code``` example"])).toEqual(["```js code``` 示例"]);
    expect(parseTranslations("```js\nrunA()\n```", [codeA])).toEqual(["```js\nrunA()\n```"]);
    expect(parseTranslations("```js\nrunA()\n```\n\n%%\n\n```js\nrunB()\n```", [codeA, codeB])).toEqual(["```js\nrunA()\n```", "```js\nrunB()\n```"]);
    expect(parseTranslations("```\n```js\nrunA()\n```\n```", [codeA])).toEqual(["```\n```js\nrunA()\n```\n```"]);
  });

  it("rejects a result with missing items", () => {
    expect(() => parseTranslations("你好", ["Hello", "World"])).toThrow("译文数量");
  });

  it("rejects blank translations", () => {
    expect(() => parseTranslations(" \n ", ["Blank"])).toThrow("未返回译文");
    expect(() => parseTranslations("你好\n\n%%\n\n \n\n%%\n\n世界", ["Hello", "Blank", "World"])).toThrow("未返回译文");
    expect(() => parseTranslations("你好\n\n%%\n\n", ["Hello", "World"])).toThrow("未返回译文");
  });
});

describe("AI translation prompt", () => {
  it("names the target language instead of passing its code", () => {
    const prompt = buildSystemPrompt("zh-TW");
    expect(prompt).toContain("You are a professional Traditional Chinese native translator");
    expect(prompt).not.toContain("zh-TW");
  });

  it("falls back to the raw code for unknown languages", () => {
    expect(buildSystemPrompt("pt-BR")).toContain("translate text into pt-BR.");
  });

  it("mentions the source language in the user prompt only when it is not auto", () => {
    expect(buildUserPrompt(["Hello"], "de", "en")).toBe("Translate from German to English: Hello");
    expect(buildUserPrompt(["Hello"], "auto", "ja")).toBe("Translate to Japanese: Hello");
    expect(buildUserPrompt(["A", "B"], "pt-BR", "zh-CN")).toBe("Translate from pt-BR to Simplified Chinese: A\n\n%%\n\nB");
  });
});

describe("OpenAI batch translation", () => {
  const settings = { ...DEFAULT_SETTINGS, provider: "openai" as const, apiKey: "test-key" };
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const userMessageOf = (init: RequestInit) => (JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> }).messages;
  const encode = (text: string) => new TextEncoder().encode(text);
  const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const DONE = "data: [DONE]\n\n";
  const finalChunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\n`;
  // 真实 fetch 被中止时响应体会以 AbortError 结束，模拟流也要跟着 signal 走
  const sse = (chunks: string[], options: { keepOpen?: boolean; fail?: boolean; onCancel?: () => void } = {}) => (_url: string, init: RequestInit) =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {}
        });
        chunks.forEach((chunk) => controller.enqueue(encode(chunk)));
        if (options.fail) controller.error(new TypeError("socket closed"));
        else if (!options.keepOpen) controller.close();
      },
      cancel: options.onCancel,
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("joins paragraphs with %% and maps the separated reply back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("你好\n\n%%\n\n世界"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Hello", "World"], settings, "en", "zh-CN")).resolves.toEqual(["你好", "世界"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const messages = userMessageOf(init);
    expect(messages[0]).toEqual({ role: "system", content: buildSystemPrompt("zh-CN") });
    expect(messages[0].content).toContain("professional Simplified Chinese native translator");
    expect(messages[1]).toEqual({ role: "user", content: "Translate from English to Simplified Chinese: Hello\n\n%%\n\nWorld" });
  });

  it("keeps a paragraph containing a literal %% in the same single request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("用 %% 打印字面量百分号\n\n%%\n\n第二段\n\n%%\n\n第三段"));
    vi.stubGlobal("fetch", fetchMock);
    const texts = ["Use %% to print a literal percent sign.", "Second paragraph.", "Third paragraph."];
    await expect(translateTexts(texts, settings, "en", "zh-CN")).resolves.toEqual(["用 %% 打印字面量百分号", "第二段", "第三段"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(userMessageOf(init)[1].content).toBe("Translate from English to Simplified Chinese: Use %% to print a literal percent sign.\n\n%%\n\nSecond paragraph.\n\n%%\n\nThird paragraph.");
  });

  it("keeps a split-off fragment that is exactly %% out of the request", async () => {
    for (const maxChars of [100, DEFAULT_SETTINGS.maxCharsPerRequest]) {
      const fragments = splitText("A".repeat(maxChars - 2) + " %%", maxChars);
      expect(fragments).toEqual(["A".repeat(maxChars - 2), "%%"]);
      const fetchMock = vi.fn().mockResolvedValue(reply("译文"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(translateTexts(fragments, settings, "en", "zh-CN")).resolves.toEqual(["译文", "%%"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(userMessageOf(init)[1].content).toBe(`Translate from English to Simplified Chinese: ${"A".repeat(maxChars - 2)}`);
    }
  });

  const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;
  const thinkingKeys = ["thinking", "enable_thinking", "reasoning_effort", "reasoning", "chat_template_kwargs"];
  const thinkingKeysOf = (init: RequestInit) => Object.keys(bodyOf(init)).filter((key) => thinkingKeys.includes(key));

  it("sends only the chosen vendor's thinking-off parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("通义"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Qwen only"], { ...settings, apiVendor: "qwen" }, "en", "zh-CN")).resolves.toEqual(["通义"]);
    const body = bodyOf(fetchMock.mock.calls[0][1] as RequestInit);
    expect(body).toMatchObject({ enable_thinking: false, model: DEFAULT_SETTINGS.apiModel, temperature: DEFAULT_SETTINGS.temperature });
    expect(thinkingKeysOf(fetchMock.mock.calls[0][1] as RequestInit)).toEqual(["enable_thinking"]);
  });

  it("sends no thinking parameter by default, when no vendor is chosen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("默认"));
    vi.stubGlobal("fetch", fetchMock);
    expect(settings.apiVendor).toBe("none");
    await expect(translateTexts(["Vendor none"], settings, "en", "zh-CN")).resolves.toEqual(["默认"]);
    expect(thinkingKeysOf(fetchMock.mock.calls[0][1] as RequestInit)).toEqual([]);
  });

  it("pins the temperature Kimi requires in non-thinking mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("月之暗面"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Kimi temperature"], { ...settings, apiVendor: "kimi" }, "en", "zh-CN")).resolves.toEqual(["月之暗面"]);
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit)).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.6 });
  });

  it("lets the custom extra body override the vendor preset but never the messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("自定义"));
    vi.stubGlobal("fetch", fetchMock);
    const extraBody = '{"reasoning_effort":"low","max_tokens":4096,"messages":[]}';
    await expect(translateTexts(["Custom wins"], { ...settings, apiVendor: "openai", extraBody }, "en", "zh-CN")).resolves.toEqual(["自定义"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(bodyOf(init)).toMatchObject({ reasoning_effort: "low", max_tokens: 4096 });
    expect(userMessageOf(init)[1].content).toBe("Translate from English to Simplified Chinese: Custom wins");
  });

  it("surfaces a 400 from the service without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Preset rejected"], { ...settings, apiVendor: "openai" }, "en", "zh-CN")).rejects.toThrow("Unsupported parameter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps translations cached per API configuration, even when an old request finishes late", async () => {
    let releaseOld = () => {};
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseOld = () => resolve(reply("旧配置")); }))
      .mockImplementation(() => reply("新配置"));
    vi.stubGlobal("fetch", fetchMock);
    const oldConfig = { ...settings, apiModel: "model-a", apiVendor: "qwen" as const, extraBody: '{"max_tokens":20}' };
    const newConfig = { ...settings, apiModel: "model-b", apiVendor: "deepseek" as const, extraBody: '{"max_tokens":40}' };

    const pending = translateTexts(["Race"], oldConfig, "en", "zh-CN");
    await expect(translateTexts(["Race"], newConfig, "en", "zh-CN")).resolves.toEqual(["新配置"]);
    releaseOld();
    await expect(pending).resolves.toEqual(["旧配置"]);

    await expect(translateTexts(["Race"], newConfig, "en", "zh-CN")).resolves.toEqual(["新配置"]);
    await expect(translateTexts(["Race"], oldConfig, "en", "zh-CN")).resolves.toEqual(["旧配置"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(translateTexts(["Race"], { ...newConfig, extraBody: "{oops" }, "en", "zh-CN")).rejects.toThrow("额外请求参数");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks for a streamed reply and reassembles it across chunk boundaries", async () => {
    const second = delta("\n\n世界");
    const fetchMock = vi.fn().mockImplementation(sse([delta("你好\n\n%%"), second.slice(0, 12), second.slice(12), DONE]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Streamed hello", "Streamed world"], settings, "en", "zh-CN")).resolves.toEqual(["你好", "世界"]);
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).stream).toBe(true);
  });

  it("surfaces an error object delivered inside the stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(sse([delta("半"), 'data: {"error":{"message":"quota exceeded"}}\n\n'])));
    await expect(translateTexts(["Stream error"], settings, "en", "zh-CN")).rejects.toThrow("quota exceeded");
  });

  it("finishes as soon as [DONE] arrives even if the connection stays open", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(sse([delta("完整"), DONE], { keepOpen: true, onCancel: cancel })));
    await expect(translateTexts(["Done but open"], settings, "en", "zh-CN")).resolves.toEqual(["完整"]);
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts EOF after a finish_reason without [DONE]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(sse([delta("完"), finalChunk("整")])));
    await expect(translateTexts(["Finish reason"], settings, "en", "zh-CN")).resolves.toEqual(["完整"]);
  });

  it("treats EOF without a completion marker as truncated, retries and never caches the fragment", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(sse([delta("只返回了前半")])).mockImplementation(sse([delta("完整译文"), DONE]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Truncated"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(["完整译文"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(translateTexts(["Truncated"], settings, "en", "zh-CN")).resolves.toEqual(["完整译文"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a truncated stream once every attempt is cut short", async () => {
    const fetchMock = vi.fn().mockImplementation(sse([delta("半")]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Always truncated"], settings, "en", "zh-CN");
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).rejects.toThrow("AI 服务响应不完整");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a stream that stalls for 30 seconds", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(sse([delta("半")], { keepOpen: true })).mockImplementation(sse([delta("重来"), DONE]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Stalled once"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toEqual(["重来"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout once every stream stalls", async () => {
    const fetchMock = vi.fn().mockImplementation(sse([delta("半")], { keepOpen: true }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Always stalled"], settings, "en", "zh-CN");
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(93_000);
    await expect(pending).rejects.toThrow("服务响应超时");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a stream whose connection drops", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(sse([delta("半")], { fail: true })).mockImplementation(sse([delta("重连"), DONE]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Dropped stream"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(["重连"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a plain request when the service rejects streaming", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Response(JSON.stringify({ error: { message: "stream is not supported" } }), { status: 400 }))
      .mockImplementation(() => reply("非流式"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["No streaming"], settings, "en", "zh-CN")).resolves.toEqual(["非流式"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).stream).toBe(true);
    expect(bodyOf(fetchMock.mock.calls[1][1] as RequestInit).stream).toBe(false);
  });

  it("stops retrying once the caller cancels, without waiting out the backoff", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response("", { status: 429, headers: { "retry-after": "43200" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = translateTexts(["Cancelled"], settings, "en", "zh-CN", controller.signal);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).rejects.toThrow("翻译已取消");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries when a plain JSON body hangs", async () => {
    const hanging = (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        controller.enqueue(encode('{"choices":[{"message":{"content":"半'));
      },
    }), { status: 200 });
    const fetchMock = vi.fn().mockImplementationOnce(hanging).mockImplementation(() => reply("恢复"));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["JSON hang"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toEqual(["恢复"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries when a plain JSON body's connection drops", async () => {
    const dropped = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('{"choices":'));
        controller.error(new TypeError("socket closed"));
      },
    }), { status: 200 });
    const fetchMock = vi.fn().mockImplementationOnce(dropped).mockImplementation(() => reply("重连"));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["JSON drop"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(["重连"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a malformed plain JSON body without retrying", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response("<html>oops</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["JSON garbage"], settings, "en", "zh-CN")).rejects.toThrow("AI 服务返回格式异常");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a request whose headers never arrive and retries it", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(hang).mockImplementationOnce(hang).mockImplementation(() => reply("终于"));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Hanging request"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(63_000);
    await expect(pending).resolves.toEqual(["终于"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a timeout once every attempt hangs", async () => {
    const fetchMock = vi.fn().mockImplementation(hang);
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Always hanging"], settings, "en", "zh-CN");
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(93_000);
    await expect(pending).rejects.toThrow("服务响应超时");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(() => reply("恢复"));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Network blip"], settings, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(["恢复"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an extra body that is not a JSON object before sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const extraBody of ["{oops", "[1]", '"text"', "null"]) {
      await expect(translateTexts(["Broken extra body"], { ...settings, extraBody }, "en", "zh-CN")).rejects.toThrow("额外请求参数");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backs off and retries a 429 before propagating the service error", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Use %% once.", "Plain paragraph."], settings, "en", "zh-CN");
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).rejects.toThrow("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a whitespace-only reply instead of showing an empty translation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(" \n ")));
    await expect(translateTexts(["Blank"], settings, "en", "zh-CN")).rejects.toThrow("未返回译文");
  });
});

describe("Google batch translation", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts a JSON body that never finishes and retries", async () => {
    const hanging = (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        controller.enqueue(new TextEncoder().encode('["你'));
      },
    }), { status: 200 });
    const fetchMock = vi.fn().mockImplementationOnce(hanging).mockImplementation(() => json(["你好"]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Body hang"], DEFAULT_SETTINGS, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toEqual(["你好"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the whole batch as one request and maps auto-detected results back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([["你好", "en"], ["世界", "en"]]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Hello", "World"], DEFAULT_SETTINGS, "auto", "zh-CN")).resolves.toEqual(["你好", "世界"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=zh-CN");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("q=Hello&q=World");
  });

  it("waits for Retry-After on 429 and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(json(["再试一次"]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Try again"], DEFAULT_SETTINGS, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual(["再试一次"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits until an HTTP-date Retry-After has passed before retrying", async () => {
    vi.setSystemTime(new Date("2026-09-16T14:00:00Z"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "Wed, 16 Sep 2026 14:01:00 GMT" } }))
      .mockResolvedValueOnce(json(["一分钟后"]));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["A minute later"], DEFAULT_SETTINGS, "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(59000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(["一分钟后"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after two backoff retries on persistent server errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = translateTexts(["Service down"], DEFAULT_SETTINGS, "en", "zh-CN");
    const outcome = expect(pending).rejects.toThrow("503");
    await vi.advanceTimersByTimeAsync(3000);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns symbol-only texts untouched without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["%%", "…", "→"], DEFAULT_SETTINGS, "en", "zh-CN")).resolves.toEqual(["%%", "…", "→"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a response whose item count does not match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(["只有一个"])));
    await expect(translateTexts(["One", "Two"], DEFAULT_SETTINGS, "en", "zh-CN")).rejects.toThrow("格式异常");
  });

  it("sends only the texts missing from the cache and puts each translation back in its own slot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(["已缓存"])));
    await expect(translateTexts(["Cached before"], DEFAULT_SETTINGS, "en", "zh-CN")).resolves.toEqual(["已缓存"]);
    const fetchMock = vi.fn().mockResolvedValue(json(["新一", "新二"]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["New first", "Cached before", "New second"], DEFAULT_SETTINGS, "en", "zh-CN")).resolves.toEqual(["新一", "已缓存", "新二"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).toBe("q=New+first&q=New+second");
  });
});
