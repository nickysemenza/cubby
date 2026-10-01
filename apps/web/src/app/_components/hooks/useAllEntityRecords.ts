import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import {
  compileEntityListInput,
  type EntityListParams,
  entityListFor,
} from "~/entities/entity-list";
import type { ListEntity } from "~/entities/generated/entity-lists.gen";
import { useHydratedLoading } from "~/hooks/useHydrated";

import { flattenUniquePageItems } from "./infinite-page-utils";

/** Keeps fetching until an infinite query has loaded every page. */
export function useLoadAllPages(
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isError: boolean;
    fetchNextPage: (options: { cancelRefetch: false }) => void;
  },
  enabled = true,
) {
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && !isError) {
      fetchNextPage({ cancelRefetch: false });
    }
  }, [enabled, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
}

/**
 * Every row of an entity's list, for the surfaces that need the complete set
 * (schedules, vocabularies, pickers): the client twin of the server's
 * `listAll`. Pages are drained in order, so `isLoading` stays true until the
 * last one lands. `input` defaults to an unfiltered 500-row page size.
 */
export function useAllEntityRecords<E extends ListEntity>(
  entity: E,
  input?: EntityListParams<E>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const query = useInfiniteQuery({
    ...entityListFor(entity).infiniteQueryOptions(
      input ?? compileEntityListInput(entity, {}, { pageSize: 500 }),
    ),
    enabled,
  });
  useLoadAllPages(query, enabled);
  const records = useMemo(
    () => flattenUniquePageItems(query.data?.pages),
    [query.data],
  );
  return {
    records,
    totalCount: query.data?.pages[0]?.meta.totalCount,
    isLoading: useHydratedLoading(
      enabled &&
        (query.isPending || query.hasNextPage || query.isFetchingNextPage),
    ),
    error: query.error,
    refetch: query.refetch,
  };
}

export type AllEntityRecords<E extends ListEntity> = ReturnType<
  typeof useAllEntityRecords<E>
>;
