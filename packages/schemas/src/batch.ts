import { z } from "zod";

/** Item counts on streamed batch operations; per-item payloads extend this. */
export const batchProgressEvent = z.object({
  type: z.literal("progress"),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/**
 * Positional, independent results for a batched operation: one failed item
 * never fails its siblings, and `results[i]` answers `items[i]`. Pair with
 * `settleBatch` (server) and `createRequestBatcher` (web).
 */
export const batchResultSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), message: z.string() }),
  ]);

export const batchOutSchema = <T extends z.ZodType>(value: T) =>
  z.object({ results: z.array(batchResultSchema(value)) });

export type BatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export type BatchOut<T> = { results: BatchResult<T>[] };
