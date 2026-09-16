import { describe, expect, it } from "vitest";
import { batchSizeFor, breakSentences, leadingCount, splitText } from "../src/paragraphs";

describe("request batching", () => {
  it("stops before the character cap but always sends at least one paragraph", () => {
    expect(batchSizeFor([40, 40, 40], 100)).toBe(2);
    expect(batchSizeFor([500, 10], 100)).toBe(1);
    expect(batchSizeFor([], 100)).toBe(0);
  });

  it("splits over-limit text at sentence ends, then spaces, then hard cuts", () => {
    expect(splitText("First one here. Second one there. Third", 20)).toEqual(["First one here.", "Second one there.", "Third"]);
    expect(splitText("no sentence ends but plenty of spaces here", 12)).toEqual(["no sentence", "ends but", "plenty of", "spaces here"]);
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(splitText("short", 100)).toEqual(["short"]);
    expect(splitText("第一句。第二句。", 4)).toEqual(["第一句。", "第二句。"]);
  });

  it("takes leading paragraphs until the eager budget is reached", () => {
    expect(leadingCount([30, 30, 30], 50)).toBe(2);
    expect(leadingCount([30, 30], 0)).toBe(0);
    expect(leadingCount([], 50)).toBe(0);
  });
});

describe("sentence breaks", () => {
  const long = "First sentence ends here. Second one is next! Third asks a question? 第四句是中文。最后一句没有句号 and pi is 3.14 exactly";

  it("inserts a line break after each sentence of a long paragraph", () => {
    expect(breakSentences(long)).toBe("First sentence ends here.\nSecond one is next!\nThird asks a question?\n第四句是中文。\n最后一句没有句号 and pi is 3.14 exactly");
  });

  it("leaves short paragraphs untouched", () => {
    expect(breakSentences("Short. Two sentences.")).toBe("Short. Two sentences.");
  });
});
