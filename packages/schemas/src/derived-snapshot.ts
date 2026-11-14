import { z } from "zod";
export const snapshotProgress = z.object({
  running: z.boolean(),
  target: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  failures: z.int().nonnegative(),
  error: z.string().nullable(),
  durationsMs: z.array(z.number().nonnegative()),
  lastMovementAt: z.iso.datetime().nullable(),
  cleanAt: z.iso.datetime().nullable(),
  pages: z.int().nonnegative(),
  processedRecords: z.int().nonnegative(),
  failedPages: z.int().nonnegative(),
  history: z.array(
    z.object({
      startedAt: z.string(),
      finishedAt: z.string(),
      durationMs: z.number(),
      pages: z.int(),
      processedRecords: z.int(),
      failedPages: z.int(),
    }),
  ),
});

export type SnapshotProgress = z.infer<typeof snapshotProgress>;
