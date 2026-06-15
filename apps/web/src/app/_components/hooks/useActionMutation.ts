import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "~/lib/error-utils";

/** A tRPC `*.mutationOptions` reference, e.g. `api.ingredient.create.mutationOptions`. */
type MutationOptionsFn = (opts: never) => UseMutationOptions<
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any,
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any,
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any
>;

/** The mutation's success-result type, recovered from the options it produces. */
type DataOf<TFn extends MutationOptionsFn> =
  ReturnType<TFn> extends UseMutationOptions<infer TData, infer _E, infer _V>
    ? TData
    : never;
/** The mutation's input/variables type, recovered from the options it produces. */
type VariablesOf<TFn extends MutationOptionsFn> =
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
  invalidateKeys = [],
  onSuccess,
  error,
}: {
  mutationFn: TFn;
  /** Success toast — a fixed string or one derived from the result. */
  success: string | ((data: DataOf<TFn>) => string);
  /** Entity lists to invalidate. Each is wrapped to match tRPC's nested key structure. */
  invalidateKeys?: readonly QueryKey[];
  /** Side effect after the toast + invalidations (close dialog, resolve, navigate). */
  onSuccess?: (data: DataOf<TFn>) => void;
  /** Error toast — defaults to `getErrorMessage(err)`. */
  error?: string | ((err: unknown) => string);
}) {
  const queryClient = useQueryClient();

  const mutationOptions = mutationFn({
    onSuccess: (data: DataOf<TFn>) => {
      toast.success(typeof success === "function" ? success(data) : success);
      for (const key of invalidateKeys) {
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({ queryKey: [key] });
      }
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
