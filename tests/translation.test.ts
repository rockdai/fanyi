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

  afterEach(() => vi.unstubAllGlobals());

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

  it("merges the extra body JSON into the request without overriding the dedicated fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("不思考"));
    vi.stubGlobal("fetch", fetchMock);
    const extraBody = '{"thinking":{"type":"disabled"},"model":"ignored"}';
    await expect(translateTexts(["No thinking"], { ...settings, extraBody }, "en", "zh-CN")).resolves.toEqual(["不思考"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.model).toBe(DEFAULT_SETTINGS.apiModel);
  });

  it("rejects an extra body that is not a JSON object before sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const extraBody of ["{oops", "[1]", '"text"', "null"]) {
      await expect(translateTexts(["Broken extra body"], { ...settings, extraBody }, "en", "zh-CN")).rejects.toThrow("额外请求参数");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the service error message and sends nothing else", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateTexts(["Use %% once.", "Plain paragraph."], settings, "en", "zh-CN")).rejects.toThrow("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
