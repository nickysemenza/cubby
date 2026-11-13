import { createHash } from "node:crypto";

import { type FinancialBookingPreview } from "@cubby/schemas/financial-booking";

/** Preserve persisted JSON fingerprint bytes without a separate encoding buffer. */
export const digestValue = <T extends object>(value: T) => {
  const serialized = JSON.stringify(value);
  return createHash("sha256")
    .update(serialized ?? "")
    .digest("hex");
};

/** The caller emits validated canonical JSON without splitting surrogate pairs. */
export const digestCanonicalEvidenceStream = (
  writeEvidence: (write: (fragment: string) => void) => void,
) => {
  const hash = createHash("sha256");
  let buffered = '{"evidence":"';
  writeEvidence((fragment) => {
    // Escaping is additive across fragments with complete Unicode characters.
    const escaped = JSON.stringify(fragment).slice(1, -1);
    if (buffered.length + escaped.length > 32_768) {
      hash.update(buffered);
      buffered = escaped;
    } else buffered += escaped;
  });
  hash.update(buffered);
  hash.update('"}');
  return hash.digest("hex");
};

/**
 * The lineage `loadFinancialBookingLineages` reads for bookings whose only
 * rows are the inserted aggregates: no attributions or source claims, and
 * each row as the insert returned it (every column, in table order).
 */
export function freshBookingLineages<
  Row extends { id: string; bookingTransactionCode: string | null },
>(reviews: readonly FinancialBookingPreview[], rows: readonly Row[]) {
  const ordered = [...rows].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return new Map(
    reviews.map((review) => [
      review.transactionId,
      {
        lines: ordered.filter(
          (row) => row.bookingTransactionCode === review.transactionId,
        ),
        attributions: [],
        sourceClaims: [],
      },
    ]),
  );
}
