import { z } from "zod";
import { confidence } from "./ai.js";
import { importExtractionOutcome } from "./purchase-import.js";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const emailCandidateSource = z
  .object({
    sourceKey: z.string().min(1).max(512),
    checksum,
    content: z.string().max(200_000),
  })
  .strict();
export type EmailCandidateSource = z.infer<typeof emailCandidateSource>;
/** Spans are UTF-16 offsets into the exact, checksum-fenced source content. */
export const emailEvidenceCandidate = z
  .object({
    id: checksum,
    sourceKey: z.string().min(1).max(512),
    checksum,
    contentChecksum: checksum,
    span: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .refine((value) => value.end > value.start),
    extraction: importExtractionOutcome.refine(
      (value) => value.status === "ready",
      "Only whole validated ready orders are selectable",
    ),
  })
  .strict();
export type EmailEvidenceCandidate = z.infer<typeof emailEvidenceCandidate>;
export const preparedEmailCandidates = z
  .object({
    sourceKey: z.string().min(1).max(512),
    checksum,
    contentChecksum: checksum,
    candidates: z.array(emailEvidenceCandidate).max(8),
    reason: z.string().nullable(),
  })
  .strict();
export type PreparedEmailCandidates = z.infer<typeof preparedEmailCandidates>;
export const emailCandidateDecision = z
  .object({
    selectedIndex: z.number().int().nonnegative().nullable(),
    confidence,
    probability: z.number().finite().min(0).max(1),
    ranked: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            probability: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();
export type EmailCandidateDecision = z.infer<typeof emailCandidateDecision>;
const metadata = {
  sourceKey: z.string().min(1).max(512),
  checksum,
  contentChecksum: checksum,
  candidates: z.array(emailEvidenceCandidate).max(8),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  runId: z.uuid().nullable(),
  usageId: z.uuid().nullable(),
  operation: z.literal("mailbox-order-candidate"),
};
export const emailCandidatePreview = z.discriminatedUnion("status", [
  z
    .object({
      ...metadata,
      status: z.literal("selected"),
      candidateId: checksum,
      candidate: emailEvidenceCandidate,
      decision: emailCandidateDecision,
    })
    .strict(),
  z
    .object({
      ...metadata,
      status: z.literal("abstained"),
      reason: z.string().min(1),
      decision: emailCandidateDecision.nullable(),
    })
    .strict(),
]);
export type EmailCandidatePreview = z.infer<typeof emailCandidatePreview>;
