import type { SourceTransactionRecordInput } from "@cubby/schemas/source-transaction-record";
import { cents } from "@cubby/shared";
import { z } from "zod";

import { sha256Text as sha256Hex } from "~/server/lib/sha256-text";

/** A unique legacy alias can join observations within the same source. */
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

export type SourceTransactionRecordIdentityInput = {
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
 * carry both refs; that is why settlement references have no primary slot.
 */
export function sourceTransactionRecordExternalId(
  row: SourceTransactionRecordIdentityInput,
): string {
  const payload = [
    `${row.source}:v1`,
    canonical(row.account),
    row.date,
    String(cents(row.amount)),
    canonical(row.originalStatement),
  ].join(SEPARATOR);
  return `v1:${sha256Hex(payload)}`;
}

/** Immutable observation identity. Provider IDs and content are reconciliation
 * evidence; neither may collapse two positions in the same export. */
export function sourceTransactionRecordOccurrenceId(
  source: string,
  fingerprint: string,
  rowPosition: number,
): string {
  const payload = JSON.stringify([source, "v2", fingerprint, rowPosition]);
  return `v2:${sha256Hex(payload)}`;
}

export const PROVIDER_IDENTITY_REVIEW =
  "This provider identity has ambiguous historical account evidence; resolve its charge identity before continuing.";

const rawProviderIds = z.object({
  id: z.string().optional(),
  account_id: z.string().optional(),
  transaction: z
    .object({ id: z.string(), account_id: z.string().optional() })
    .optional(),
  account: z.union([z.object({ id: z.string() }), z.string()]).optional(),
});

type ProviderIdentityClaims = {
  accounts: string[];
  providerIds: string[];
  malformed: boolean;
};

/** All retained string claims participate in proof and contradiction checks. Missing claims never prove identity. */
export function providerIdentityClaims(
  data: SourceTransactionRecordInput["providerData"],
): ProviderIdentityClaims {
  const raw = rawProviderIds.safeParse(data);
  if (!raw.success)
    return {
      accounts: [],
      providerIds: [],
      malformed:
        data !== null && typeof data === "object" && !Array.isArray(data),
    };
  return {
    malformed: false,
    // A bare `account` string is Monarch's display label, not an account ID.
    accounts: [
      raw.data.account_id,
      typeof raw.data.account === "string" ? undefined : raw.data.account?.id,
      raw.data.transaction?.account_id,
    ].filter((id) => id !== undefined),
    providerIds: [raw.data.id, raw.data.transaction?.id].filter(
      (id) => id !== undefined,
    ),
  };
}
