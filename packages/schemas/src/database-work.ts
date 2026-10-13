import { z } from "zod";

export const databaseWorkPriority = z.enum(["interactive", "background"]);
export type DatabaseWorkPriority = z.infer<typeof databaseWorkPriority>;

export const databaseWorkSnapshot = z.object({
  active: z.number().int().nonnegative(),
  backgroundActive: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  oldestQueuedMs: z.number().nonnegative(),
});
export type DatabaseWorkSnapshot = z.infer<typeof databaseWorkSnapshot>;

export const databaseWorkRequest = z.object({
  priority: databaseWorkPriority,
  waitTimeoutMs: z.number().int().min(1).max(30_000).default(30_000),
});
export type DatabaseWorkRequest = z.input<typeof databaseWorkRequest>;

export const databaseWorkReady = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type DatabaseWorkReady = z.infer<typeof databaseWorkReady>;
