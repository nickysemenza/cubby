import { wholeCentAmount } from "./money";
import { plainDate, uniqueBy } from "./base-entity";
import { financialTransactionShortcode } from "./identifier-fields";
import { z } from "zod";

export const ledgerTransferAmount = wholeCentAmount.positive();

export const ledgerSource = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase source slug")
  .meta({ mockValue: "synthetic-source" });
export const ledgerSourceClaimNormalizedEvidence = z.strictObject({
  amount: wholeCentAmount,
  occurredOn: plainDate.nullable().default(null),
  description: z.string().trim().min(1).nullable().default(null),
  context: z.string().trim().min(1).nullable().default(null),
  disambiguator: z.string().trim().min(1).nullable().default(null),
});
export type LedgerSourceClaimNormalizedEvidence = z.infer<
  typeof ledgerSourceClaimNormalizedEvidence
>;
export const ledgerSourceClaimReconciliation = z.discriminatedUnion(
  "decision",
  [
    z.strictObject({ decision: z.literal("amounts_match") }),
    z.strictObject({
      decision: z.literal("accept_target_amount"),
      note: z.string().trim().min(1),
    }),
  ],
);
export type LedgerSourceClaimReconciliation = z.infer<
  typeof ledgerSourceClaimReconciliation
>;
const ledgerSourceClaimInputFields = {
  source: ledgerSource,
  providerId: z.string().trim().min(1).optional(),
  normalizedEvidence: ledgerSourceClaimNormalizedEvidence,
  reconciliation: ledgerSourceClaimReconciliation,
};
export const ledgerSourceClaimInput = z.strictObject(
  ledgerSourceClaimInputFields,
);
export type LedgerSourceClaimInput = z.infer<typeof ledgerSourceClaimInput>;
export const ledgerSourceClaims = z
  .array(ledgerSourceClaimInput)
  .refine(
    ...uniqueBy<LedgerSourceClaimInput>(
      (claim) =>
        claim.providerId
          ? `provider\u0000${claim.source}\u0000${claim.providerId}`
          : `canonical\u0000${claim.source}\u0000${claim.normalizedEvidence.occurredOn ?? ""}\u0000${claim.normalizedEvidence.amount}\u0000${claim.normalizedEvidence.description ?? ""}\u0000${claim.normalizedEvidence.context ?? ""}\u0000${claim.normalizedEvidence.disambiguator ?? ""}`,
      "sourceClaims must not contain duplicate canonical evidence",
    ),
  );
export const ledgerSourceClaimOut = z.object({
  source: ledgerSource,
  normalizedEvidence: ledgerSourceClaimNormalizedEvidence,
  reconciliation: ledgerSourceClaimReconciliation,
  sourceKey: z.string().min(1),
  sourceKeyVersion: z.number().int().positive(),
  targetAmountAtClaim: wholeCentAmount,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const ledgerSourceClaimsOut = z.array(ledgerSourceClaimOut);
export type LedgerSourceClaimOut = z.infer<typeof ledgerSourceClaimOut>;
export const ledgerTransferEvidenceTransactionIds = z
  .array(financialTransactionShortcode)
  .max(2)
  .refine(
    ...uniqueBy(
      (id) => id,
      "evidenceTransactionIds must not contain duplicates",
    ),
  );
export const ledgerTransferClassification = z.enum([
  "internal_move",
  "contribution",
  "household_distribution",
  "reimbursement",
]);
