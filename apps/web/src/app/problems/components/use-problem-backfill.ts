import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";

/** Result-driven toast: which sonner variant to fire and with what message. */
export type BackfillToast = { tone: "success" | "info"; message: string };

/** A tRPC `*.mutationOptions` reference, e.g. `api.problems.reparseStale.mutationOptions`. */
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
 * Shared plumbing for the "fix all" actions on the Problems page.
 *
 * Every backfill mutation does the same three things on success — toast a
 * result-derived message, then invalidate the problems list plus one entity
 * list — and toast `getErrorMessage` on failure. This hook owns that so each
 * list component only declares its mutation, its extra invalidate keys, and how
 * to phrase the result. `TData`/`TVariables` are inferred from the passed
 * `*.mutationOptions` reference, so callers need no generics.
 */
export function useProblemBackfill<TFn extends MutationOptionsFn>({
  mutationFn,
  invalidateKeys = [],
  toastResult,
}: {
  mutationFn: TFn;
  /** Extra keys to invalidate alongside the problems list. Wrapped to match tRPC's nested structure. */
  invalidateKeys?: readonly QueryKey[];
  toastResult: (data: DataOf<TFn>) => BackfillToast;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const mutationOptions = mutationFn({
    onSuccess: (data: DataOf<TFn>) => {
      const { tone, message } = toastResult(data);
      toast[tone](message);
      // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
      queryClient.invalidateQueries({
        queryKey: [api.problems.getAllProblems.queryKey()],
      });
      for (const key of invalidateKeys) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  } as never);

  return useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>(
    mutationOptions as Parameters<
      typeof useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>
    >[0],
  );
}
