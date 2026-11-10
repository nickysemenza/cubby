import { sql, type SQLWrapper } from "drizzle-orm";

// A printed field label before the identifier: `Trip ID: X`, `Order number: X`,
// `Confirmation No. X:`-style prefixes, or `Order #X`. Only a label ending in an
// id/number word followed by `:`/`#`, or words followed by `#`, is removed, so
// identifiers that merely contain letters (`INV-123`, `ID-9`) are unchanged.
const LABEL_WORDS = String.raw`(?:[A-Za-z][A-Za-z.]*\s+){0,3}`;
const ID_LABEL = String.raw`^\s*${LABEL_WORDS}(?:id|no\.?|number|num)\s*[:#]\s*`;
const HASH_LABEL = String.raw`^\s*(?:[A-Za-z][A-Za-z.]*\s+){1,3}#\s*`;
const ID_LABEL_RE = new RegExp(ID_LABEL, "iu");
const HASH_LABEL_RE = new RegExp(HASH_LABEL, "iu");

/**
 * The order identifier a source printed, without its field label. Extraction
 * keeps what the page shows, so one vendor's order can arrive as `Trip ID: X`
 * in one Email and `X` in another; Purchases store this canonical form.
 */
export const canonicalOrderId = (value: string | null): string | null => {
  if (value === null) return null;
  const stripped = value
    .replace(ID_LABEL_RE, "")
    .replace(HASH_LABEL_RE, "")
    .trim();
  return stripped.length > 0 ? stripped : value.trim();
};

/**
 * An order number as keys and Purchase lookups compare it: label removed,
 * trimmed, leading `#` removed, upper-cased. Hyphens and suffixes stay, so an
 * Amazon `NNN-NNNNNNN-NNNNNNN` id or a split-shipment `-2` remains its own key.
 */
export const normalizeOrderKey = (value: string) =>
  (canonicalOrderId(value) ?? value)
    .trim()
    .replace(/^#+/u, "")
    .trim()
    .toUpperCase();

/** `normalizeOrderKey` for a stored order id column. */
export const normalizedOrderIdSql = (column: SQLWrapper) =>
  sql<string>`upper(btrim(regexp_replace(btrim(regexp_replace(regexp_replace(${column}, ${ID_LABEL}, '', 'i'), ${HASH_LABEL}, '', 'i')), '^#+', '')))`;
