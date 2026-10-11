import { z } from "zod";
import { emailShortcode, runShortcode } from "./identifier-fields.js";

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
