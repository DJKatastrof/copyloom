// Search with room for typos. Tier 0: the query appears as typed. Tier 1: every word of the
// query appears somewhere, exactly or with a typo. Tier 0 is listed first.
export type Tier = 0 | 1;

// Typo matching only looks at the start of long clips; exact matching reads all of the text.
const FUZZY_TEXT = 4000;
const WORD = /[\p{L}\p{N}]+/gu;

function budget(token: string): number {
  if (token.length > 64) return 0;
  return token.length >= 9 ? 2 : token.length >= 5 ? 1 : 0;
}

/** Edits (with swapped neighbours as one) between `token` and the word or the start of it. */
export function typoDistance(token: string, word: string, limit: number): number {
  const n = token.length;
  if (word.length < n - limit) return limit + 1;
  const m = Math.min(word.length, n + limit);
  let before = new Array<number>(m + 1).fill(0), previous = Array.from({ length: m + 1 }, (_, j) => j), current = new Array<number>(m + 1);
  for (let i = 1; i <= n; i++) {
    current[0] = i; let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = token[i - 1] === word[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && token[i - 1] === word[j - 2] && token[i - 2] === word[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current[j] = value; if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    [before, previous, current] = [previous, current, before];
  }
  // The full word, or a prefix of about the token's length: "konfg" finds "konfiguration".
  let result = limit + 1;
  for (let j = Math.max(0, n - limit); j <= m; j++) result = Math.min(result, previous[j]);
  return result;
}

export function wordsOf(text: string): string[] {
  return [...new Set(text.slice(0, FUZZY_TEXT).match(WORD) ?? [])].filter(word => word.length >= 3);
}

/** One matcher per query; typo results are shared across clips with the same words. */
export function createMatcher(query: string) {
  const phrase = query.trim().toLocaleLowerCase('sv');
  const tokens = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  const seen = tokens.map(() => new Map<string, boolean>());
  return (text: string, words: () => string[], extra: readonly string[] = []): Tier | null => {
    if (!phrase || text.includes(phrase) || extra.some(value => value.includes(phrase))) return 0;
    let list: string[] | undefined;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (text.includes(token) || extra.some(value => value.includes(token))) continue;
      const limit = budget(token);
      if (!limit) return null;
      list ??= words();
      const cache = seen[index];
      const found = list.some(word => {
        let hit = cache.get(word);
        if (hit === undefined) { hit = typoDistance(token, word, limit) <= limit; cache.set(word, hit); }
        return hit;
      });
      if (!found) return null;
    }
    return 1;
  };
}
