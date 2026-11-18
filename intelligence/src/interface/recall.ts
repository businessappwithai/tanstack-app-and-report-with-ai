/**
 * Keyword recall over memories, shared by every provider.
 *
 * A memory's content is held where only our server can read it (in Buzz it is NIP-44-encrypted), so
 * ranking happens here rather than in a search index. The score is the share of the query's words a
 * memory contains, with a small bonus for each repeat, so "weekly summary" ranks a memory about
 * weekly summaries above one that only says "weekly". Memories that match no word are left out.
 */
import type { MemoryScope, MemorySummary } from "./types";

const WORD = /[\p{L}\p{N}]+/gu;

export function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((word) => word.length > 1);
}

export function rankMemories(
  memories: MemorySummary[],
  query: { query: string; limit?: number; scope?: MemoryScope }
): Array<MemorySummary & { score: number }> {
  const terms = [...new Set(words(query.query))];
  if (terms.length === 0) return [];
  const scored: Array<MemorySummary & { score: number }> = [];
  for (const memory of memories) {
    if (memory.invalidatedAt !== null) continue;
    if (query.scope && memory.scope !== query.scope) continue;
    const counts = new Map<string, number>();
    for (const word of words(memory.content)) counts.set(word, (counts.get(word) ?? 0) + 1);
    let matched = 0;
    let repeats = 0;
    for (const term of terms) {
      const count = counts.get(term) ?? 0;
      if (count > 0) {
        matched += 1;
        repeats += count - 1;
      }
    }
    if (matched === 0) continue;
    const score = matched / terms.length + Math.min(repeats, 5) * 0.01;
    scored.push({ ...memory, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  return scored.slice(0, query.limit && query.limit > 0 ? query.limit : 10);
}
