import { z } from "zod";
import {
  mailboxClassification,
  mailboxClassificationStage,
} from "./mailbox-research.js";

export const emailClassificationOperation = z.enum([
  "mailbox-triage",
  "mailbox-relevance",
]);
export type EmailClassificationOperation = z.infer<
  typeof emailClassificationOperation
>;

export const emailClassificationConflict = z
  .object({ kind: z.literal("accepted_unrelated") })
  .strict();
export type EmailClassificationConflict = z.infer<
  typeof emailClassificationConflict
>;
export const emailClassificationObservationInput = z
  .object({
    emailId: z.uuid(),
    runId: z.uuid().nullable().default(null),
    checksum: z.string().nullable(),
    classification: mailboxClassification,
    stage: mailboxClassificationStage.nullable(),
    reason: z.string().nullable(),
    classificationVersion: z.string().nullable(),
    model: z.string().nullable().default(null),
    promptVersion: z.string().nullable().default(null),
    operation: emailClassificationOperation.nullable().default(null),
    usageId: z.uuid().nullable().default(null),
    conflict: emailClassificationConflict.nullable().default(null),
  })
  .strict();
export const emailClassificationLabelInput = z
  .object({
    predictionId: z.uuid(),
    classification: mailboxClassification,
    reason: z.string(),
    actorUserId: z.string().min(1),
  })
  .strict();
export const emailRetrievalFailureInput = z
  .object({
    emailId: z.uuid(),
    runId: z.uuid().nullable().default(null),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    error: z.string().min(1),
  })
  .strict();
