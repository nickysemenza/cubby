import { z } from "zod";
import { derivedRefreshReceipt } from "./derived-refresh";

export const mutationSideEffectsSchema = z.object({
  derivedRefresh: derivedRefreshReceipt.optional(),
  /**
   * Best-effort follow-up work that failed after the write itself succeeded
   * (e.g. a UPC cover-photo import), as raw diagnostics. Absent when nothing
   * failed; web toasts each one and MCP returns them as-is.
   */
  warnings: z.array(z.string()).optional(),
});
export type MutationSideEffects = z.infer<typeof mutationSideEffectsSchema>;

export const EMPTY_MUTATION_SIDE_EFFECTS: MutationSideEffects = {};

export const mutationSideEffectsWithWarnings = (
  warnings: readonly string[] | undefined,
): MutationSideEffects =>
  warnings && warnings.length > 0
    ? { warnings: [...warnings], derivedRefresh: { mode: "background" } }
    : { derivedRefresh: { mode: "background" } };
