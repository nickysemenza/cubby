import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  plainDate,
  timestampedFields,
  uniqueBy,
} from "./base-entity";
import {
  financialTransactionShortcode,
  ledgerPartyShortcode,
  ledgerTransferShortcode,
} from "./identifiers";
import { wholeCentAmount } from "./money";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";

const source = z
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
  source,
  providerId: z.string().trim().min(1).optional(),
  normalizedEvidence: ledgerSourceClaimNormalizedEvidence,
  reconciliation: ledgerSourceClaimReconciliation,
};
export const ledgerSourceClaimInput = z.strictObject(
  ledgerSourceClaimInputFields,
);
export type LedgerSourceClaimInput = z.infer<typeof ledgerSourceClaimInput>;

export const ledgerSourceClaims = z.array(ledgerSourceClaimInput).refine(
  ...uniqueBy((claim: LedgerSourceClaimInput) => {
    if (claim.providerId)
      return `provider\u0000${claim.source}\u0000${claim.providerId}`;
    return `canonical\u0000${claim.source}\u0000${claim.normalizedEvidence.occurredOn ?? ""}\u0000${claim.normalizedEvidence.amount}\u0000${claim.normalizedEvidence.description ?? ""}\u0000${claim.normalizedEvidence.context ?? ""}\u0000${claim.normalizedEvidence.disambiguator ?? ""}`;
  }, "sourceClaims must not contain duplicate canonical evidence"),
);

const ledgerTransferFields = {
  fromPartyId: ledgerPartyShortcode,
  toPartyId: ledgerPartyShortcode,
  amount: wholeCentAmount.positive(),
  date: plainDate,
  notes: z.string().nullable(),
};

export const ledgerTransferEvidenceTransactionIds = z
  .array(financialTransactionShortcode)
  .max(2)
  .refine(
    ...uniqueBy(
      (id) => id,
      "evidenceTransactionIds must not contain duplicates",
    ),
  );

const ledgerTransferCreateShape = {
  ...ledgerTransferFields,
  notes: z.string().nullable().default(null),
  sourceClaims: ledgerSourceClaims.nullable().default([]),
  evidenceTransactionIds: ledgerTransferEvidenceTransactionIds
    .nullable()
    .default([]),
};

export const ledgerTransferCreateInput = z.object(ledgerTransferCreateShape);
export type LedgerTransferCreateInput = z.infer<
  typeof ledgerTransferCreateInput
>;

export const ledgerTransferUpdateData = deriveUpdateData(
  ledgerTransferCreateShape,
);
export type LedgerTransferUpdateData = z.infer<typeof ledgerTransferUpdateData>;

export const ledgerTransferUpdateInput = z.object({
  id: ledgerTransferShortcode,
  data: ledgerTransferUpdateData,
});
export type LedgerTransferUpdateInput = z.infer<
  typeof ledgerTransferUpdateInput
>;

export const ledgerTransferFilterFields = {
  ...auditDateFilterFields,
  fromPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  toPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
};
export const ledgerTransferFiltersSchema = z.object(ledgerTransferFilterFields);
export type LedgerTransferFilters = z.infer<typeof ledgerTransferFiltersSchema>;

export const ledgerTransferSortableFields = [
  "date",
  "amount",
  "createdAt",
  "updatedAt",
] as const;
export type LedgerTransferSortField =
  (typeof ledgerTransferSortableFields)[number];

export const ledgerSourceClaimOut = z.object({
  source: ledgerSourceClaimInputFields.source,
  normalizedEvidence: ledgerSourceClaimInputFields.normalizedEvidence,
  reconciliation: ledgerSourceClaimInputFields.reconciliation,
  sourceKey: z.string().min(1),
  sourceKeyVersion: z.number().int().positive(),
  targetAmountAtClaim: wholeCentAmount,
  ...timestampedFields,
});
export type LedgerSourceClaimOut = z.infer<typeof ledgerSourceClaimOut>;

export const ledgerTransferOut = z.object({
  id: ledgerTransferShortcode,
  ...ledgerTransferFields,
  classification: z.enum([
    "internal_move",
    "contribution",
    "household_distribution",
    "reimbursement",
  ]),
  sourceClaims: z.array(ledgerSourceClaimOut),
  evidenceTransactionIds: z.array(financialTransactionShortcode),
  ...timestampedFields,
});
export type LedgerTransferOut = z.infer<typeof ledgerTransferOut>;

export const ledgerTransferListResponse =
  createPaginatedResponseSchema(ledgerTransferOut);
export type LedgerTransferListResponse = z.infer<
  typeof ledgerTransferListResponse
>;
