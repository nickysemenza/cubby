import { cents } from "./money";

/**
 * The identity function for a provider statement row.
 *
 * A statement row has no natural key: exports carry no stable row id, and the
 * client-supplied `key` is unique only within one request. So identity is a
 * content hash over the fields a provider actually originates, and that hash is
 * what `FinancialTransaction.sourceRefs` stores. Match state everywhere else is
 * derived from it, which makes this file load-bearing for reconciliation as a
 * whole — it lives on its own so the preview and any future ledger cannot drift
 * apart on what a row *is*.
 *
 * Changing `canonical`, `cents`, or the payload composition silently orphans
 * every ref already stored. Treat the shape below as frozen and version through
 * the `v1:` prefix instead.
 */

/**
 * Fold away the differences an export can introduce without the underlying
 * charge changing: unicode form, surrounding and repeated whitespace, case.
 */
const canonical = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * NUL, not a printable delimiter: a descriptor that happened to contain the
 * separator must not be able to shift a field boundary and collide with a
 * different row. Written as an escape so the source file stays plain ASCII.
 */
const SEPARATOR = "\u0000";

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export type StatementRowIdentityInput = {
  /** Provider slug. Namespaces the hash — see the note on collisions below. */
  source: string;
  /** The export's own account label, verbatim. */
  account: string;
  /** The date as the export stated it, `YYYY-MM-DD`. */
  date: string;
  /** Provider-signed amount, pre-normalization (Monarch signs charges negative). */
  amount: number;
  /** The raw statement descriptor. */
  originalStatement: string;
};

/**
 * Derive the stable `v1:` reference for a statement row.
 *
 * Deliberately excludes mutable cleanup metadata — a provider's merchant label,
 * its category, the export filename — so re-exporting after re-categorizing in
 * Monarch does not mint a second identity for the same charge.
 *
 * The payload is namespaced by `source`, not by a constant. Two providers
 * describing one charge must stay two rows: measured against real exports, 19%
 * of charges present in both Copilot and Monarch carry different dates (the
 * providers disagree on posting vs transaction date) and their account
 * descriptors differ too, so a source-independent namespace would collide only
 * by coincidence — and where it did collide it would silently merge two
 * independent observations into one, destroying exactly the cross-corroboration
 * that makes "absent from both exports" usable evidence. One transaction can
 * carry both refs; that is what `sourceRefs` being an array is for.
 */
export async function statementRowExternalId(
  row: StatementRowIdentityInput,
): Promise<string> {
  const payload = [
    `${row.source}:v1`,
    canonical(row.account),
    row.date,
    String(cents(row.amount)),
    canonical(row.originalStatement),
  ].join(SEPARATOR);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `v1:${toHex(digest)}`;
}
