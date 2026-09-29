// FTS5 parses the MATCH argument as an expression language, not as text: any
// character outside [A-Za-z0-9_] / non-ASCII is a syntax token, so a raw
// "all-purpose flour" reads as `all - purpose` and the whole statement fails
// (D1 surfaced that as HTTP 500 on /api/foods; `&`, `(`, and `:` broke the same
// way). Two guards, both required:
//   1. Split on the characters the unicode61 tokenizer already treats as
//      separators at index time, so the terms line up with the indexed tokens.
//   2. Quote every term so AND/OR/NOT/NEAR and `column:` filters typed by a
//      user stay literal instead of being interpreted.
// The prefix `*` on the last term keeps type-ahead behaviour.
const FTS_SEPARATORS = /[^\p{L}\p{N}_]+/u;

export function toFtsQuery(raw: string): string {
  const terms = (raw || "").split(FTS_SEPARATORS).filter(Boolean);
  if (terms.length === 0) return "";
  return terms
    .map((term, i) => (i === terms.length - 1 ? `"${term}"*` : `"${term}"`))
    .join(" ");
}

// Recipe-style names ("chicken breast ground raw") carry words a USDA
// description omits, so the implicit AND of `toFtsQuery` can return nothing.
// The fallback is an OR over every k-term AND-group instead of a bare OR of
// all terms: a bare OR lets one common word ("chicken") pull in every branded
// row that mentions it. FTS5 has no "at least k of n" operator, so the groups
// are enumerated; the term cap bounds C(n, k) (56 groups at 8 terms).
const FALLBACK_MIN_TERMS = 3;
const FALLBACK_MAX_TERMS = 8;
const FALLBACK_MIN_SHARE = 0.6;

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) =>
    combinations(items.slice(index + 1), size - 1).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

/**
 * The MATCH string to run when `toFtsQuery` finds nothing: any record holding
 * at least 60% of the terms (never fewer than two). Empty when the query has
 * fewer than three terms, where a share below all of them is one term.
 */
export function toFtsFallbackQuery(raw: string): string {
  const terms = (raw || "")
    .split(FTS_SEPARATORS)
    .filter(Boolean)
    .slice(0, FALLBACK_MAX_TERMS);
  if (terms.length < FALLBACK_MIN_TERMS) return "";
  const quoted = terms.map((term, i) =>
    i === terms.length - 1 ? `"${term}"*` : `"${term}"`,
  );
  const required = Math.max(2, Math.ceil(terms.length * FALLBACK_MIN_SHARE));
  return combinations(quoted, required)
    .map((group) => `(${group.join(" ")})`)
    .join(" OR ");
}
