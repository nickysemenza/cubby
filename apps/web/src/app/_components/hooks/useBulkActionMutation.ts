import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPCClient } from "~/trpc/react";
import { useBulkStream } from "./useBulkStream";

type TRPCClient = ReturnType<typeof useTRPCClient>;

/**
 * Streaming sibling of {@link useActionMutation} for bulk actions whose server
 * procedure is a `.mutation(async function*)` yielding {@link BulkProgressEvent}s.
 * Same on-success contract (toast → invalidate → side effect; error toast), but
 * the work streams in one request so it also exposes `{done,total}` progress for
 * a `<Progress>` bar. The result type is inferred from `run`'s streamed mutation.
 *
 * `run` opens the stream from the vanilla client, e.g.
 * `(client, vars) => client.product.createMany.mutate(vars)`.
 */
export function useBulkActionMutation<Vars, Result>({
  run,
  success,
  invalidateKeys = [],
  onSuccess,
  error,
}: {
  run: (
    client: TRPCClient,
    vars: Vars,
  ) => Promise<AsyncIterable<BulkProgressEvent<unknown, Result>>>;
  /** Success toast — a fixed string or one derived from the result. */
  success: string | ((data: Result) => string);
  /** Entity lists to invalidate. Each is wrapped to match tRPC's nested key structure. */
  invalidateKeys?: readonly QueryKey[];
  /** Side effect after the toast + invalidations. */
  onSuccess?: (data: Result) => void;
  /** Error toast — defaults to `getErrorMessage(err)`. */
  error?: string | ((err: unknown) => string);
}) {
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const { start, running, progress } = useBulkStream<unknown, Result>();

  const mutate = useCallback(
    (vars: Vars) =>
      void start(() => run(client, vars), {
        onDone: (data) => {
          toast.success(
            typeof success === "function" ? success(data) : success,
          );
          for (const key of invalidateKeys) {
            void queryClient.invalidateQueries({ queryKey: [key] });
          }
          onSuccess?.(data);
        },
        errorToast: (err) =>
          error === undefined
            ? getErrorMessage(err)
            : typeof error === "function"
              ? error(err)
              : error,
      }),
    [
      start,
      run,
      client,
      queryClient,
      success,
      invalidateKeys,
      onSuccess,
      error,
    ],
  );

  return { mutate, isPending: running, progress };
}
