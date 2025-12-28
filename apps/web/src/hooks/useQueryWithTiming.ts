import {
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { QueryTiming } from "~/lib/query-timing";

type UseQueryWithTimingResult<TData, TError> = UseQueryResult<TData, TError> & {
  timing: QueryTiming;
};

/**
 * Wrapper around useQuery that tracks query execution time.
 * Accepts both react-query UseQueryOptions and tRPC queryOptions return types.
 *
 * @example
 * ```tsx
 * const { data, timing } = useQueryWithTiming(
 *   trpc.product.getByID.queryOptions({ id })
 * );
 * // timing.durationMs will contain the query duration in milliseconds
 * ```
 */
export const useQueryWithTiming = <
  TQueryFnData = unknown,
  TError = Error,
  TData = TQueryFnData,
>(
  options:
    | UseQueryOptions<TQueryFnData, TError, TData>
    // biome-ignore lint/suspicious/noExplicitAny: Accept both react-query and tRPC queryOptions types
    | (Record<string, any> & { queryKey: readonly unknown[] }),
): UseQueryWithTimingResult<TData, TError> => {
  const query = useQuery(options);
  const { isFetching } = query;

  const startTimeRef = useRef<number | null>(null);
  const [timing, setTiming] = useState<QueryTiming>({
    durationMs: null,
    isFresh: false,
  });

  // Start timing when fetch begins
  useEffect(() => {
    if (isFetching && startTimeRef.current === null) {
      startTimeRef.current = performance.now();
    }
  }, [isFetching]);

  // Calculate duration when fetch completes
  useEffect(() => {
    if (!isFetching && startTimeRef.current !== null) {
      const duration = Math.round(performance.now() - startTimeRef.current);
      setTiming({ durationMs: duration, isFresh: true });
      startTimeRef.current = null;
    }
  }, [isFetching]);

  return { ...query, timing };
};
