import { z } from "zod";

/**
 * Wire-compatibility remnant of the removed background-job ledger.
 *
 * Entity mutation responses still carry `sideEffects.backgroundBatches` so
 * existing generated clients keep decoding, but no batch exists any more: the
 * array is always empty and the ref is reduced to the one field a decoder
 * needs. Nothing should read this field. The module path stays because the
 * entity generator emits imports of `mutationSideEffectsSchema` from here.
 */
export const backgroundBatchRefSchema = z.object({ id: z.string() });
/** @deprecated Always empty since the job ledger was removed. */
export type BackgroundBatchRef = z.infer<typeof backgroundBatchRefSchema>;

export const mutationSideEffectsSchema = z.object({
  backgroundBatches: z.array(backgroundBatchRefSchema).max(0),
  /**
   * Best-effort follow-up work that failed after the write itself succeeded
   * (e.g. a UPC cover-photo import), as raw diagnostics. Absent when nothing
   * failed; web toasts each one and MCP returns them as-is.
   */
  warnings: z.array(z.string()).optional(),
});
export type MutationSideEffects = z.infer<typeof mutationSideEffectsSchema>;

export const EMPTY_MUTATION_SIDE_EFFECTS: MutationSideEffects = {
  backgroundBatches: [],
};

export const mutationSideEffectsWithWarnings = (
  warnings: readonly string[] | undefined,
): MutationSideEffects =>
  warnings && warnings.length > 0
    ? { backgroundBatches: [], warnings: [...warnings] }
    : EMPTY_MUTATION_SIDE_EFFECTS;
