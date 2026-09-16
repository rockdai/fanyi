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

function cutPoint(text: string, maxChars: number): number {
  let cut = 0;
  for (const match of text.matchAll(/[。！？]|[.!?](?=\s)/g)) {
    const end = (match.index ?? 0) + 1;
    if (end > maxChars) break;
    cut = end;
  }
  if (cut) return cut;
  const space = text.lastIndexOf(" ", maxChars);
  return space > 0 ? space : maxChars;
}

export function splitText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const chunks: string[] = [];
  let rest = text.trim();
  // 优先在句末断开，其次在空白处，最后硬切，保证每段都不超过上限
  while (rest.length > limit) {
    const cut = cutPoint(rest, limit);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
