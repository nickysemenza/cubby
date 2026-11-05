import { z } from "zod";
import {
  sourceTransactionRecordDisposition,
  sourceTransactionRecordDispositionReason,
} from "./source-transaction-record-fields";
import { shortcodeSchema } from "./identifier-fields";

export const sourceOccurrenceIdentityKind = z.enum([
  "provider",
  "positioned",
  "reviewed",
]);
export const sourceOccurrenceReviewState = z.enum([
  "ready",
  "identity_conflict",
  "judgment_conflict",
  "ownership_conflict",
  "revision_order_unknown",
  "reappeared",
]);

const sourceResolutionReview = z.object({
  expectedDisposition: sourceTransactionRecordDisposition,
  expectedFactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedOccurrenceVersion: z.number().int().positive().nullable(),
  expectedAcceptedTransactionId: shortcodeSchema(
    "financialTransaction",
  ).nullable(),
  historicalTransactionIds: z.array(shortcodeSchema("financialTransaction")),
  accountId: shortcodeSchema("financialAccount"),
  note: z.string().trim().min(1),
  judgment: z.discriminatedUnion("disposition", [
    z.object({ disposition: z.literal("open") }),
    z.object({
      disposition: z.literal("ignored"),
      dispositionReason: sourceTransactionRecordDispositionReason,
      dispositionNote: z.string().trim().min(1),
    }),
  ]),
});
/** Explicit source identity judgments. Automatic planners never submit these choices. */
export const sourceIdentityResolution = z.discriminatedUnion("decision", [
  sourceResolutionReview.extend({ decision: z.literal("distinct") }),
  sourceResolutionReview.extend({
    decision: z.literal("accept_existing"),
    transactionId: shortcodeSchema("financialTransaction"),
  }),
  sourceResolutionReview.extend({
    decision: z.literal("assign"),
    occurrenceId: shortcodeSchema("sourceOccurrence"),
    expectedTargetVersion: z.number().int().positive(),
  }),
]);
export type SourceIdentityResolution = z.infer<typeof sourceIdentityResolution>;

/** Bounded owner read-back; rows retain stable identities and their owning field representations. */
export const sourceOccurrenceClosure = z.strictObject({
  root: shortcodeSchema("sourceOccurrence"),
  scope: z.array(shortcodeSchema("sourceOccurrence")).max(10),
  snapshot: z.string(),
  sets: z.strictObject({
    occurrences: z.array(z.json()),
    observations: z.array(z.json()),
    judgments: z.array(z.json()),
    aliases: z.array(z.json()),
    memberships: z.array(z.json()),
    collections: z.array(z.json()),
    transactions: z.array(z.json()),
    allocations: z.array(z.json()),
    purchases: z.array(z.json()),
    expenses: z.array(z.json()),
    recordedAttribution: z.array(z.json()),
    effectiveExpenses: z.array(z.json()),
    transfers: z.array(z.json()),
    sourceClaims: z.array(z.json()),
    paymentEvidence: z.array(z.json()),
    receiptReferences: z.array(z.json()),
  }),
});
