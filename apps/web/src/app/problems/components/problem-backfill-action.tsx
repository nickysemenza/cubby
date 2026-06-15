import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTRPC } from "~/trpc/react";
import { ProblemActionButton } from "./problem-action-button";
import {
  type BackfillToast,
  type DataOf,
  type MutationOptionsFn,
  useProblemBackfill,
  type VariablesOf,
} from "./use-problem-backfill";

type TRPCApi = ReturnType<typeof useTRPC>;

type BackfillButtonProps<TFn extends MutationOptionsFn> = {
  /** Picks the mutation off the tRPC proxy, e.g. `(api) => api.problems.reparseStale.mutationOptions`. */
  selectMutation: (api: TRPCApi) => TFn;
  /** Entity lists to invalidate alongside the problems list. */
  invalidateKeys?: (api: TRPCApi) => QueryKey[];
  toastResult: (data: DataOf<TFn>) => BackfillToast;
  idleLabel: string;
  pendingLabel: string;
  /** Mutation input, when the procedure takes one (e.g. `{ limit: 500 }`). */
  variables?: VariablesOf<TFn>;
};

/**
 * The shared "fix all" button for a Problems section, driven entirely by props.
 * It owns the `useProblemBackfill` hook at its own top level, so a section
 * declares its backfill as plain data and mounts this — no per-section
 * component. `TFn` is inferred from `selectMutation`, so `toastResult` and
 * `variables` are checked against the real mutation.
 */
export function BackfillButton<TFn extends MutationOptionsFn>({
  selectMutation,
  invalidateKeys,
  toastResult,
  idleLabel,
  pendingLabel,
  variables,
}: BackfillButtonProps<TFn>): ReactNode {
  const api = useTRPC();
  const mutation = useProblemBackfill({
    mutationFn: selectMutation(api),
    invalidateKeys: invalidateKeys?.(api),
    toastResult,
  });

  return (
    <ProblemActionButton
      onClick={() => mutation.mutate(variables as never)}
      isPending={mutation.isPending}
      idleLabel={idleLabel}
      pendingLabel={pendingLabel}
    />
  );
}
