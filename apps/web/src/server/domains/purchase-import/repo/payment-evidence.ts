import { minorToMoney } from "@cubby/shared";

import type { purchasePaymentEvidence } from "~/server/db/retained-tables";

/** Preserve the retained dollar receipt shape and key order at the read boundary. */
export const paymentEvidenceDollars = (
  row: typeof purchasePaymentEvidence.$inferSelect,
) => ({
  id: row.id,
  purchaseId: row.purchaseId,
  sourceClaimId: row.sourceClaimId,
  amount: minorToMoney(row.amountMinor),
  chargedAt: row.chargedAt,
  cardLastFour: row.cardLastFour,
  tender: row.tender,
  description: row.description,
  evidenceIndex: row.evidenceIndex,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
