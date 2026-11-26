// A printed field label before the identifier: `Trip ID: X`, `Order number: X`,
// `Confirmation No.: X` or `Order #X`. Only a label ending in an id/number word
// followed by `:`/`#`, or words followed by `#`, is removed, so `No. X` and
// identifiers that merely contain letters (`INV-123`, `ID-9`) are unchanged.
const LABEL_WORDS = String.raw`(?:[A-Za-z][A-Za-z.]*\s+){0,3}`;
export const ID_LABEL = String.raw`^\s*${LABEL_WORDS}(?:id|no\.?|number|num)\s*[:#]\s*`;
export const HASH_LABEL = String.raw`^\s*(?:[A-Za-z][A-Za-z.]*\s+){1,3}#\s*`;
// Use the same literal patterns in the schema's expression index and its queries.
export const NORMALIZED_ORDER_ID_SQL = [
  "upper(btrim(regexp_replace(btrim(regexp_replace(regexp_replace(",
  `,'${ID_LABEL}', '', 'i'), '${HASH_LABEL}', '', 'i')), '^#+', '')))`,
] as const;
