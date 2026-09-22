/**
 * Pure candidate generation and ranking for the product match queue: a stocked
 * photo-first Product on one side, a purchased Product on the other. Nothing
 * here excludes a pair on category or owner — purchase-created Products
 * usually have neither, so both are only ranking signals.
 */

export interface MatchPoolProduct<Id extends string = string> {
  id: Id;
  name: string;
  rootCategoryId: string | null;
}

export interface MatchSignals<Id extends string = string> {
  photoId: Id;
  purchaseId: Id;
  sharedTokens: string[];
  /** Overlap coefficient of the two name-token sets, 0..1. */
  overlap: number;
  /** product_to_product text-embedding similarity when the index returned it. */
  similarity: number | null;
  /** null when either side is uncategorized. */
  sameCategory: boolean | null;
  /** null when either owner is undeterminable. */
  sameOwner: boolean | null;
}

const STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "men",
  "mens",
  "women",
  "womens",
  "size",
  "pack",
  "pcs",
  "set",
  "new",
]);

const SPELLING = new Map([
  ["grey", "gray"],
  ["colour", "color"],
]);

/** Lowercased, accent-folded name words of 3+ characters, minus filler. */
function nameTokens(name: string): Set<string> {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  const tokens = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    tokens.add(SPELLING.get(word) ?? word);
  }
  return tokens;
}

/**
 * Photo × purchase pairs sharing at least one name token, via an inverted
 * index so a large purchase catalogue is never compared exhaustively. Each
 * photo product keeps its `limit` best-overlapping purchase products.
 */
type TokenPair<Id extends string> = Pick<
  MatchSignals<Id>,
  "photoId" | "purchaseId" | "sharedTokens" | "overlap"
>;

export function pairByNameTokens<Id extends string>(
  photo: readonly MatchPoolProduct<Id>[],
  purchase: readonly MatchPoolProduct<Id>[],
  limit: number,
): TokenPair<Id>[] {
  const purchaseTokens = new Map<Id, Set<string>>();
  const index = new Map<string, Id[]>();
  for (const item of purchase) {
    const tokens = nameTokens(item.name);
    purchaseTokens.set(item.id, tokens);
    for (const token of tokens) {
      const ids = index.get(token) ?? [];
      ids.push(item.id);
      index.set(token, ids);
    }
  }
  const out: TokenPair<Id>[] = [];
  for (const item of photo) {
    const tokens = nameTokens(item.name);
    const shared = new Map<Id, string[]>();
    for (const token of tokens) {
      for (const id of index.get(token) ?? []) {
        if (id === item.id) continue;
        const list = shared.get(id) ?? [];
        list.push(token);
        shared.set(id, list);
      }
    }
    const scored = [...shared].map(([purchaseId, sharedTokens]) => ({
      photoId: item.id,
      purchaseId,
      sharedTokens: sharedTokens.sort(),
      overlap:
        sharedTokens.length /
        Math.max(
          1,
          Math.min(tokens.size, purchaseTokens.get(purchaseId)?.size ?? 0),
        ),
    }));
    scored.sort(
      (a, b) =>
        b.overlap - a.overlap ||
        b.sharedTokens.length - a.sharedTokens.length ||
        a.purchaseId.localeCompare(b.purchaseId),
    );
    out.push(...scored.slice(0, limit));
  }
  return out;
}

/**
 * Text-embedding similarity leads (the brief's primary signal); name overlap
 * breaks near-ties and carries the whole ranking when the index is down.
 * Category and owner nudge but never exclude.
 */
function matchScore(signals: MatchSignals<string>): number {
  return (
    (signals.similarity ?? 0) +
    0.25 * signals.overlap +
    (signals.sameCategory === true
      ? 0.1
      : signals.sameCategory === false
        ? -0.2
        : 0) +
    (signals.sameOwner === true ? 0.05 : signals.sameOwner === false ? -0.1 : 0)
  );
}

/** Best `perPhoto` pairs for each photo product, best-first overall. */
export function rankMatches<T extends MatchSignals<string>>(
  candidates: readonly T[],
  perPhoto: number,
): T[] {
  const byPhoto = new Map<string, T[]>();
  for (const candidate of candidates) {
    const list = byPhoto.get(candidate.photoId) ?? [];
    list.push(candidate);
    byPhoto.set(candidate.photoId, list);
  }
  const kept: T[] = [];
  for (const list of byPhoto.values()) {
    list.sort(
      (a, b) =>
        matchScore(b) - matchScore(a) ||
        a.purchaseId.localeCompare(b.purchaseId),
    );
    kept.push(...list.slice(0, perPhoto));
  }
  return kept.sort(
    (a, b) =>
      matchScore(b) - matchScore(a) ||
      a.photoId.localeCompare(b.photoId) ||
      a.purchaseId.localeCompare(b.purchaseId),
  );
}

/** Human-readable evidence for a detector pair, strongest first. */
export function describeSignals(signals: MatchSignals<string>): string[] {
  const out: string[] = [];
  if (signals.similarity !== null)
    out.push(`Text similarity ${signals.similarity.toFixed(2)}`);
  if (signals.sharedTokens.length > 0)
    out.push(`Shared name words: ${signals.sharedTokens.join(", ")}`);
  if (signals.sameCategory === true) out.push("Same top-level category");
  if (signals.sameCategory === false) out.push("Different top-level category");
  if (signals.sameOwner === true) out.push("Same owner");
  if (signals.sameOwner === false) out.push("Different owners");
  return out;
}

/**
 * Cover order for a merged match survivor: the household's own photo of the
 * item leads, then catalogue/vendor imagery, then labels — so the photo that
 * made the match recognisable stays the cover. Stable within each bucket.
 */
export function matchSurvivorImageOrder<
  T extends { source: string | null; purpose: string | null },
>(images: readonly T[]): T[] {
  const bucket = (image: T) =>
    image.purpose === "label" ? 2 : image.source === "own" ? 0 : 1;
  return images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => bucket(a.image) - bucket(b.image) || a.index - b.index)
    .map(({ image }) => image);
}
