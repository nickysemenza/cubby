import type { SearchMatchKind, SearchResultItem } from "@cubby/schemas/search";
import { uniq } from "es-toolkit";

type RankedSearchResult = SearchResultItem & {
  score: number;
  matchKind: SearchMatchKind;
  matchReason: string;
  matchTerms: string[];
};

export interface SemanticCandidate<
  TItem extends SearchResultItem = SearchResultItem,
> {
  item: TItem;
  similarity: number;
  reason?: string;
}

const normalize = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "find",
  "for",
  "have",
  "in",
  "is",
  "me",
  "my",
  "of",
  "on",
  "show",
  "the",
  "to",
  "where",
  "with",
]);

function singularizeToken(token: string): string {
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}

function searchTokens(value: string): string[] {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]!;
  }

  return previous[b.length]!;
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length++;
  }
  return length;
}

function tokenPairScore(queryToken: string, fieldToken: string): number {
  const q = singularizeToken(queryToken);
  const f = singularizeToken(fieldToken);
  if (q === f) return 100;
  if (q.includes(f) || f.includes(q))
    return Math.min(q.length, f.length) >= 3 ? 85 : 0;
  if (commonPrefixLength(q, f) >= 4) return 72;

  const longest = Math.max(q.length, f.length);
  if (longest < 5) return 0;
  const similarity = 1 - editDistance(q, f) / longest;
  return similarity >= 0.72 ? Math.round(similarity * 70) : 0;
}

function itemSearchTokens(item: SearchResultItem): string[] {
  return [item.name, item.subtitle, item.typeHint].flatMap((value) =>
    value ? searchTokens(value) : [],
  );
}

function explainVisibleTermMatches(
  query: string,
  item: SearchResultItem,
): string[] {
  const queryTokens = searchTokens(query);
  const fieldTokens = itemSearchTokens(item);
  const candidates: Array<{ text: string; score: number }> = [];

  for (const queryToken of queryTokens) {
    for (const fieldToken of fieldTokens) {
      const score = tokenPairScore(queryToken, fieldToken);
      if (score <= 0) continue;
      candidates.push({
        text:
          singularizeToken(queryToken) === singularizeToken(fieldToken)
            ? fieldToken
            : `${queryToken} ~ ${fieldToken}`,
        score,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
    .flatMap((candidate) => {
      if (seen.has(candidate.text)) return [];
      seen.add(candidate.text);
      return [candidate.text];
    })
    .slice(0, 4);
}

export function explainSemanticCandidate(
  query: string,
  candidate: SemanticCandidate,
): Pick<RankedSearchResult, "matchReason" | "matchTerms"> {
  const terms = explainVisibleTermMatches(query, candidate.item);
  const similarity = candidate.similarity.toFixed(3);
  return {
    matchReason:
      terms.length > 0
        ? `Semantic vector match ${similarity}; visible term ${terms.join(", ")}`
        : `Semantic vector match ${similarity}; no visible term overlap`,
    matchTerms: terms,
  };
}

function lexicalScore(
  query: string,
  item: SearchResultItem,
): RankedSearchResult {
  const q = normalize(query);
  const fields = [item.name, item.subtitle, item.typeHint]
    .flatMap((value) => (value ? [normalize(value)] : []))
    .filter(Boolean);

  const exact = fields.some((field) => field === q);
  if (exact) {
    return {
      ...item,
      score: 100,
      matchKind: "exact",
      matchReason: "Exact lexical match",
      matchTerms: explainVisibleTermMatches(query, item),
    };
  }

  const substring = fields.some(
    (field) => field.includes(q) || q.includes(field),
  );
  const terms = explainVisibleTermMatches(query, item);
  return {
    ...item,
    score: substring ? 70 : 45,
    matchKind: substring ? "substring" : "trigram",
    matchReason: substring
      ? `Substring lexical match${terms.length ? `: ${terms.join(", ")}` : ""}`
      : `Lexical candidate${terms.length ? `: ${terms.join(", ")}` : ""}`,
    matchTerms: terms,
  };
}

function semanticScore(
  query: string,
  candidate: SemanticCandidate,
): RankedSearchResult {
  const score = Math.round(30 + candidate.similarity * 55);
  const explanation = explainSemanticCandidate(query, candidate);
  return {
    ...candidate.item,
    score,
    matchKind: "semantic",
    matchReason: candidate.reason
      ? `${candidate.reason}; ${explanation.matchReason}`
      : explanation.matchReason,
    matchTerms: explanation.matchTerms,
  };
}

export function mergeHybridSearchResults(
  query: string,
  lexical: SearchResultItem[],
  semantic: SemanticCandidate[],
  limit: number,
): RankedSearchResult[] {
  const byKey = new Map<string, RankedSearchResult>();

  for (const item of lexical) {
    const ranked = lexicalScore(query, item);
    byKey.set(`${item.entityType}:${item.id}`, ranked);
  }

  for (const candidate of semantic) {
    const key = `${candidate.item.entityType}:${candidate.item.id}`;
    const rankedSemantic = semanticScore(query, candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rankedSemantic);
      continue;
    }

    const combinedScore = Math.max(
      existing.score,
      Math.round(existing.score + rankedSemantic.score * 0.25),
    );
    byKey.set(key, {
      ...existing,
      score: combinedScore,
      matchKind: existing.matchKind === "exact" ? "exact" : "hybrid",
      matchReason:
        existing.matchKind === "exact"
          ? existing.matchReason
          : `${existing.matchReason}; ${rankedSemantic.matchReason}`,
      matchTerms: uniq([...existing.matchTerms, ...rankedSemantic.matchTerms]),
    });
  }

  return [...byKey.values()]
    .sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, limit);
}
