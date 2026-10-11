import { z } from "zod";
import { emailShortcode, runShortcode } from "./identifier-fields.js";
import {
  EMAIL_RECLASSIFY_LIMIT,
  mailboxClassification,
  mailboxClassificationStage,
} from "./mailbox-research.js";

export const emailImportInput = z
  .object({
    id: emailShortcode,
    expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const emailImportOut = z
  .object({ runIds: z.array(runShortcode) })
  .strict();
export type EmailImportInput = z.infer<typeof emailImportInput>;

export const correctEmailRelevanceInput = z
  .object({
    id: emailShortcode,
    expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    classification: z.enum(["related", "uncertain"]),
    reason: z.string().trim().min(1),
  })
  .strict();
export const correctEmailRelevanceOut = z
  .object({
    id: emailShortcode,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    classification: z.enum(["related", "uncertain"]),
    originalAvailable: z.literal(true),
  })
  .strict();
export type CorrectEmailRelevanceInput = z.infer<
  typeof correctEmailRelevanceInput
>;
export type CorrectEmailRelevanceOut = z.infer<typeof correctEmailRelevanceOut>;

export const reclassifyEmailsInput = z
  .object({
    ids: z
      .array(emailShortcode)
      .min(1)
      .max(
        EMAIL_RECLASSIFY_LIMIT,
        `Reclassify at most ${EMAIL_RECLASSIFY_LIMIT} Emails at a time.`,
      ),
  })
  .strict();
/**
 * `replaced` changed the Email's Relevance; `confirmed` kept it and refreshed
 * the deciding stage. The rest only record history: `awaiting_acceptance`
 * would drop retained content or an import, `resolution_kept` honors a
 * member's resolution, `frozen` is an admitted import source, and `removed`
 * is deleted or in Spam/Trash at Gmail.
 */
export const emailReclassifyOutcome = z.enum([
  "replaced",
  "confirmed",
  "awaiting_acceptance",
  "resolution_kept",
  "frozen",
  "removed",
  "failed",
]);
export type EmailReclassifyOutcome = z.infer<typeof emailReclassifyOutcome>;
export const reclassifyEmailsOut = z
  .object({
    runIds: z.array(runShortcode),
    results: z.array(
      z
        .object({
          id: emailShortcode,
          outcome: emailReclassifyOutcome,
          /** The rerun's result, whether or not it replaced Relevance. */
          classification: mailboxClassification.nullable(),
          stage: mailboxClassificationStage.nullable(),
          conflict: z.boolean(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ReclassifyEmailsInput = z.infer<typeof reclassifyEmailsInput>;
export type ReclassifyEmailsOut = z.infer<typeof reclassifyEmailsOut>;

export const rerunEmailPreviewInput = emailImportInput;
export const rerunEmailPreviewOut = z
  .object({
    runId: runShortcode,
    status: z.enum(["selected", "abstained"]),
    reason: z.string().nullable(),
  })
  .strict();
export type RerunEmailPreviewInput = z.infer<typeof rerunEmailPreviewInput>;
export type RerunEmailPreviewOut = z.infer<typeof rerunEmailPreviewOut>;
