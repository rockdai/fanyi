const LONG_PARAGRAPH = 100;

export function batchSizeFor(lengths: number[], maxChars: number): number {
  let total = 0;
  let count = 0;
  for (const length of lengths) {
    if (count && total + length > maxChars) break;
    total += length;
    count += 1;
  }
  return count;
}

export function leadingCount(lengths: number[], budget: number): number {
  let total = 0;
  let count = 0;
  for (const length of lengths) {
    if (total >= budget) break;
    total += length;
    count += 1;
  }
  return count;
}

export function breakSentences(text: string): string {
  if (text.length < LONG_PARAGRAPH) return text;
  return text.replace(/([。！？!?]|\.(?=\s))\s*(?=\S)/g, "$1\n");
}
