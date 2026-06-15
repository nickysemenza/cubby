import type { QueryKey } from "@tanstack/react-query";
import type {
  DataOf,
  MutationOptionsFn,
} from "~/app/problems/components/use-problem-backfill";
import { useTRPC } from "~/trpc/react";
import { useActionMutation } from "./useActionMutation";

/**
 * Per-card inline-fix mutation for the Problems page. Like {@link useActionMutation},
 * but always invalidates `problems.getAllProblems` (so the resolved card drops out
 * of the list) on top of any caller-supplied entity-list keys. This is the
 * per-card counterpart to `useProblemBackfill`, which powers the "fix all" buttons.
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
  const api = useTRPC();
  return useActionMutation({
    mutationFn,
    success,
    invalidateKeys: [api.problems.getAllProblems.queryKey(), ...invalidateKeys],
    onSuccess,
    error,
  });
}
