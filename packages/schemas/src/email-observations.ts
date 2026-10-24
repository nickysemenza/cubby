import { aiProvenance, capturedFieldInput } from "./ai-evaluation";
import { z } from "zod";
import { ledgerPartyId } from "./identifier-fields.js";
import {
  mailboxClassification,
  mailboxClassificationStage,
} from "./mailbox-research.js";

const originalDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const originalBinding = z.object({
  provider: z.literal("gmail"),
  ledgerPartyId,
  mailboxId: z.string().min(1),
  messageId: z.string().min(1),
  threadId: z.string().nullable(),
  internalDate: z.string().nullable(),
});
export const emailOriginalCaptureProblem = z.object({
  reason: z.enum([
    "identity_mismatch",
    "missing_payload",
    "missing_mime_type",
    "invalid_encoding",
    "invalid_size",
    "size_mismatch",
    "conflicting_payload",
    "capture_limit",
  ]),
  part: z.string(),
});
export const emailOriginalPartCapture = z.object({
  path: z.string().min(1),
  metadataDigest: originalDigest,
  bodyDigest: originalDigest,
  bodyBytes: z.number().int().nonnegative(),
});
/** Complete source capture is evidence, never an equivalence rule or application authority. */
export const emailOriginalCapture = z.discriminatedUnion("status", [
  z.object({
    version: z.literal("gmail-original-v1"),
    status: z.literal("complete"),
    binding: originalBinding,
    parts: z.array(emailOriginalPartCapture).min(1).max(512),
    contentDigest: originalDigest,
  }),
  z.object({
    version: z.literal("gmail-original-v1"),
    status: z.literal("incomplete"),
    binding: originalBinding,
    problem: emailOriginalCaptureProblem,
  }),
]);
export type EmailOriginalCapture = z.infer<typeof emailOriginalCapture>;

/** Declared logical requests, not answering-model or provider-wire attestations. */
export const emailLogicalInputCapture = z.object({
  version: z.literal("gmail-logical-inputs-v1"),
  inputs: z.array(capturedFieldInput).min(1),
});
export const emailClassificationPublicationEvidence = z.object({
  originalCapture: emailOriginalCapture.optional(),
  logicalInputCapture: emailLogicalInputCapture.optional(),
});
export type EmailClassificationPublicationEvidence = z.infer<
  typeof emailClassificationPublicationEvidence
>;

export const emailClassificationOperation = z.enum([
  "mailbox-triage",
  "mailbox-relevance",
]);
export type EmailClassificationOperation = z.infer<
  typeof emailClassificationOperation
>;

/** A prediction that disagrees with protected evidence: an accepted Purchase or the member's own review. */
export const emailClassificationConflict = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted_unrelated") }).strict(),
  z
    .object({
      kind: z.literal("member_review"),
      memberClassification: mailboxClassification,
    })
    .strict(),
]);
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
    evaluationId: z.uuid().nullable().default(null),
    provenance: aiProvenance.nullable().default(null),
    conflict: emailClassificationConflict.nullable().default(null),
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
