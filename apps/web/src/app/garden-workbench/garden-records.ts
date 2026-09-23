import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { flattenUniquePageItems } from "~/app/_components/hooks/infinite-page-utils";
import {
  compileEntityListInput,
  entityListFor,
} from "~/entities/entity-list.functions";
import { useHydratedLoading } from "~/hooks/useHydrated";

const plantingList = entityListFor("planting");
const plantList = entityListFor("plant");
const plantingInput = compileEntityListInput("planting", {}, { pageSize: 500 });
const plantInput = compileEntityListInput("plant", {}, { pageSize: 500 });

function useLoadAllPages(
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isError: boolean;
    fetchNextPage: (options: { cancelRefetch: false }) => void;
  },
  enabled: boolean,
) {
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && !isError) {
      fetchNextPage({ cancelRefetch: false });
    }
  }, [enabled, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
}

export function usePlantingRecords(enabled = true) {
  const query = useInfiniteQuery({
    ...plantingList.infiniteQueryOptions(plantingInput),
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

export function usePlantRecords(enabled = true) {
  const query = useInfiniteQuery({
    ...plantList.infiniteQueryOptions(plantInput),
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
