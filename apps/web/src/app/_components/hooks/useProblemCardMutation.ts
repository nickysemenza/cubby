import type { QueryKey } from "@tanstack/react-query";
import type {
  DataOf,
  MutationOptionsFn,
} from "~/app/problems/components/use-problem-backfill";
import { queryKeys } from "~/lib/query-keys";
import { useActionMutation } from "./useActionMutation";

/**
 * Per-card inline-fix mutation for the Problems page. Like {@link useActionMutation},
 * but always invalidates the whole `problems.*` path (so the resolved card drops
 * out of whichever cost-grouped detector query owns it, and the badge's combined
 * scan) on top of any caller-supplied entity-list keys. This is the per-card
 * counterpart to `useProblemBackfill`, which powers the "fix all" buttons.
 *
 * `TData`/`TVariables` are inferred from the passed `*.mutationOptions` reference,
 * so callers need no generics.
 */
export function useProblemCardMutation<TFn extends MutationOptionsFn>({
  mutationFn,
  success,
  invalidateKeys = [],
  onSuccess,
  error,
}: {
  mutationFn: TFn;
  /** Success toast — a fixed string or one derived from the result. */
  success: string | ((data: DataOf<TFn>) => string);
  /** Entity lists to invalidate alongside the always-included problems list. */
  invalidateKeys?: readonly QueryKey[];
  /** Side effect after the toast + invalidations (typically `close`). */
  onSuccess?: (data: DataOf<TFn>) => void;
  error?: string | ((err: unknown) => string);
}) {
  return useActionMutation({
    mutationFn,
    success,
    invalidateKeys: [queryKeys.problems.all, ...invalidateKeys],
    onSuccess,
    error,
  });
}
