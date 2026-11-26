import { HASH_LABEL, ID_LABEL } from "@cubby/schemas/purchase-order-identity";

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
