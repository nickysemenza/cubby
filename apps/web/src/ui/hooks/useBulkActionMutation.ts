import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import {
  EMPTY_INVALIDATION_TAG_SET,
  type InvalidationTagSet,
} from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { getErrorMessage, type UnparsedError } from "~/lib/error-utils";

import { useBulkStream } from "./useBulkStream";

/**
 * Stable empty default — `invalidateTags` is a dependency of the `mutate`
 * callback below, so an inline `= []` would hand every caller that omits it a
 * fresh reference (and a fresh `mutate`) on every render.
 */
const NO_INVALIDATE_TAGS = EMPTY_INVALIDATION_TAG_SET;

const isSuccessMessageFactory = <Result>(
  value: string | ((data: Result) => string),
): value is (data: Result) => string => typeof value === "function";

const isErrorMessageFactory = (
  value: string | ((error: UnparsedError) => string),
): value is (error: UnparsedError) => string => typeof value === "function";

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
  invalidateTags = NO_INVALIDATE_TAGS,
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
  /**
   * Cache tags to invalidate after the workflow finishes. Spelled out here
   * rather than taken from a descriptor: the work streams in one held-open
   * request, so there is no `useMutation` for the root cache to read `meta` off.
   */
  invalidateTags?: InvalidationTagSet;
  /** Side effect after the toast + invalidations. */
  onSuccess?: (data: Result) => void;
  /** Error toast — defaults to `getErrorMessage(err)`. */
  error?: string | ((err: UnparsedError) => string);
}) {
  const queryClient = useQueryClient();
  const { start, running, progress } = useBulkStream<unknown, Result>();

  const mutateAsync = useCallback(
    (vars: Vars) =>
      start(() => Promise.resolve(run(vars)), {
        onDone: (data) => {
          toast.success(
            isSuccessMessageFactory(success) ? success(data) : success,
          );
          void invalidateOperationTags(queryClient, invalidateTags);
          onSuccess?.(data);
        },
        errorToast: (err) =>
          error === undefined
            ? getErrorMessage(err)
            : isErrorMessageFactory(error)
              ? error(err)
              : error,
      }),
    [start, run, queryClient, success, invalidateTags, onSuccess, error],
  );

  const mutate = useCallback(
    (vars: Vars) => {
      void mutateAsync(vars);
    },
    [mutateAsync],
  );

  return { mutate, mutateAsync, isPending: running, progress };
}
