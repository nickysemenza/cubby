import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useTRPC } from "~/integrations/trpc/react";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries } from "~/lib/query-keys";

/** A tRPC `*.mutationOptions` reference, e.g. `api.ingredient.create.mutationOptions`. */
export type MutationOptionsFn = (opts: never) => UseMutationOptions<
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any,
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any,
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any
>;

/** The mutation's success-result type, recovered from the options it produces. */
export type DataOf<TFn extends MutationOptionsFn> =
  ReturnType<TFn> extends UseMutationOptions<infer TData, infer _E, infer _V>
    ? TData
    : never;
/** The mutation's input/variables type, recovered from the options it produces. */
export type VariablesOf<TFn extends MutationOptionsFn> =
  ReturnType<TFn> extends UseMutationOptions<
    infer _D,
    infer _E,
    infer TVariables
  >
    ? TVariables
    : never;

/**
 * The common write-mutation shape: on success toast a message (optionally
 * derived from the result), invalidate caches, and run any side effect (close a
 * dialog, resolve a value, navigate); on error toast a message. `TData`/
 * `TVariables` are inferred from the passed `*.mutationOptions` reference, so
 * callers need no generics.
 *
 * For the fixed "{Entity} updated" toast use {@link useUpdateMutation}; for the
 * Problems-page "fix all" buttons use `useProblemBackfill`.
 */
export function useActionMutation<TFn extends MutationOptionsFn>({
  mutationFn,
  success,
  successToastId,
  invalidateKeys = [],
  onSuccess,
  error,
}: {
  mutationFn: TFn;
  /**
   * Success toast — a fixed message or one derived from the result. Omit to skip
   * the toast entirely (for silent-invalidation or caller-toast flows); the
   * invalidation, background-batch re-invalidation, and `onSuccess` still run.
   */
  success?: ReactNode | ((data: DataOf<TFn>) => ReactNode);
  /**
   * Stable sonner toast id — repeated successes replace the same toast instead
   * of stacking. Load-bearing for range cell-paste, where every applied cell
   * fires this mutation's toast: N pastes collapse into one refreshing toast
   * next to the paste-summary toast.
   */
  successToastId?: string;
  /** Entity lists to invalidate. Each is wrapped to match tRPC's nested key structure. */
  invalidateKeys?: readonly QueryKey[];
  /** Side effect after the toast + invalidations (close dialog, resolve, navigate). */
  onSuccess?: (data: DataOf<TFn>) => void;
  /** Error toast — defaults to `getErrorMessage(err)`. */
  error?: string | ((err: unknown) => string);
}) {
  const queryClient = useQueryClient();
  const api = useTRPC();

  const mutationOptions = mutationFn({
    onSuccess: (data: DataOf<TFn>) => {
      if (success !== undefined) {
        toast.success(
          typeof success === "function" ? success(data) : success,
          successToastId === undefined ? undefined : { id: successToastId },
        );
      }
      invalidateTRPCQueries(queryClient, invalidateKeys);
      // Re-invalidate once any queued background work the action enqueued drains.
      void watchBatchesAndInvalidate({
        queryClient,
        result: data,
        invalidateKeys,
        fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
      });
      onSuccess?.(data);
    },
    onError: (err: unknown) => {
      toast.error(
        error === undefined
          ? getErrorMessage(err)
          : typeof error === "function"
            ? error(err)
            : error,
      );
    },
  } as never);

  return useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>(
    mutationOptions as Parameters<
      typeof useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>
    >[0],
  );
}
