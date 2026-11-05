import { z } from "zod";
import { sourceTransactionRecordDispositionReason } from "./source-transaction-record-fields";
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
