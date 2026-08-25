import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateQueryRoots } from "~/lib/query-keys";
import { useBulkStream } from "./useBulkStream";

/**
 * Stable empty default — `invalidateKeys` is a dependency of the `mutate`
 * callback below, so an inline `= []` would hand every caller that omits it a
 * fresh reference (and a fresh `mutate`) on every render.
 */
const NO_INVALIDATE_KEYS: readonly QueryKey[] = [];

/**
 * Streaming sibling of {@link useActionMutation} for bulk actions whose server
 * workflow yields {@link BulkProgressEvent}s.
 * Same on-success contract (toast → invalidate → side effect; error toast), but
 * the work streams in one request so it also exposes `{done,total}` progress for
 * a `<Progress>` bar. The result type is inferred from `run`'s streamed mutation.
 *
 * `run` opens the stream for the supplied variables.
 */
export function useBulkActionMutation<Vars, Result>({
  run,
  success,
  invalidateKeys = NO_INVALIDATE_KEYS,
  onSuccess,
  error,
}: {
  run: (
    vars: Vars,
  ) =>
    | AsyncIterable<BulkProgressEvent<unknown, Result>>
    | Promise<AsyncIterable<BulkProgressEvent<unknown, Result>>>;
  /** Success toast — a fixed string or one derived from the result. */
  success: string | ((data: Result) => string);
  /** Query roots to invalidate after the workflow finishes. */
  invalidateKeys?: readonly QueryKey[];
  /** Side effect after the toast + invalidations. */
  onSuccess?: (data: Result) => void;
  /** Error toast — defaults to `getErrorMessage(err)`. */
  error?: string | ((err: unknown) => string);
}) {
  const queryClient = useQueryClient();
  const { start, running, progress } = useBulkStream<unknown, Result>();

  const mutate = useCallback(
    (vars: Vars) =>
      void start(() => Promise.resolve(run(vars)), {
        onDone: (data) => {
          toast.success(
            typeof success === "function" ? success(data) : success,
          );
          invalidateQueryRoots(queryClient, invalidateKeys);
          onSuccess?.(data);
        },
        errorToast: (err) =>
          error === undefined
            ? getErrorMessage(err)
            : typeof error === "function"
              ? error(err)
              : error,
      }),
    [start, run, queryClient, success, invalidateKeys, onSuccess, error],
  );

  return { mutate, isPending: running, progress };
}
