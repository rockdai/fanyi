import { describe, expect, it } from "vitest";
import { parseTranslationArray } from "../src/translation";

describe("AI translation parser", () => {
  it("accepts a fenced JSON array", () => {
    expect(parseTranslationArray('```json\n["你好", "世界"]\n```', 2)).toEqual(["你好", "世界"]);
  });

  it("rejects a result with missing items", () => {
    expect(() => parseTranslationArray('["你好"]', 2)).toThrow("译文数量");
  });
});
