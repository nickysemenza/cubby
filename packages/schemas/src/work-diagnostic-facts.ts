import { z } from "zod";

const diagnosticCount = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const diagnosticKey = z.string().min(1).max(128);

/** Private finding identity and captions are published; authorization is always current. */
const workDiagnosticEntry = z.object({
  key: z.string().min(1),
  name: z.string(),
  reason: z.string(),
  refs: z
    .array(
      z.object({
        type: z.enum([
          "financialAccount",
          "financialTransaction",
          "expense",
          "purchase",
        ]),
        shortcode: z.string().min(1),
      }),
    )
    .min(1),
});

export const workDiagnosticCounts = z.object({
  counts: z
    .record(diagnosticKey, diagnosticCount)
    .refine((counts) => Object.keys(counts).length <= 64),
});

/** Counts and private findings belong to one retained successful publication. */
export const workDiagnosticFacts = workDiagnosticCounts.extend({
  privateEntries: z.record(diagnosticKey, z.array(workDiagnosticEntry)),
});
export type WorkDiagnosticFacts = z.infer<typeof workDiagnosticFacts>;

export const incompleteWorkDiagnosticSource = z.object({
  key: diagnosticKey,
  state: z.enum(["stale", "unavailable"]),
  pending: z.boolean(),
  error: z.string().nullable(),
  computedAt: z.string().nullable(),
});
export type IncompleteWorkDiagnosticSource = z.infer<
  typeof incompleteWorkDiagnosticSource
>;
