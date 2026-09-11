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
