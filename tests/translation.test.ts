import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildTranslationPrompt, parseTranslations, translateTexts } from "../src/translation";

describe("AI translation parser", () => {
  it("splits multi-paragraph output on the %% separator", () => {
    expect(parseTranslations("你好\n\n%%\n\n世界\n", 2)).toEqual(["你好", "世界"]);
  });

  it("returns single-paragraph output as is", () => {
    expect(parseTranslations("  你好  ", 1)).toEqual(["你好"]);
  });

  it("rejects a result with missing items", () => {
    expect(() => parseTranslations("你好", 2)).toThrow("译文数量");
  });
});

describe("AI translation prompt", () => {
  it("names the target language instead of passing its code", () => {
    const prompt = buildTranslationPrompt("zh-TW");
    expect(prompt).toContain("You are a professional Traditional Chinese native translator");
    expect(prompt).not.toContain("zh-TW");
  });

  it("falls back to the raw code for unknown languages", () => {
    expect(buildTranslationPrompt("pt-BR")).toContain("translate text into pt-BR.");
  });
});

describe("OpenAI batch translation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("joins paragraphs with %% and maps the separated reply back", async () => {
    const reply = { choices: [{ message: { content: "你好\n\n%%\n\n世界" } }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const settings = { ...DEFAULT_SETTINGS, provider: "openai" as const, apiKey: "test-key" };
    await expect(translateTexts(["Hello", "World"], settings, "en", "zh-CN")).resolves.toEqual(["你好", "世界"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({ role: "system", content: buildTranslationPrompt("zh-CN") });
    expect(body.messages[0].content).toContain("professional Simplified Chinese native translator");
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello\n\n%%\n\nWorld" });
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

  it("rejects a response whose item count does not match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(["只有一个"])));
    await expect(translateTexts(["One", "Two"], DEFAULT_SETTINGS, "en", "zh-CN")).rejects.toThrow("格式异常");
  });
});
