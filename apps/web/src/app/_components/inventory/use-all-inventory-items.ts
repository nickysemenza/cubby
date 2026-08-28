import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { z } from "zod";

import { entityListFor } from "~/entities/entity-list.functions";

import { flattenUniquePageItems } from "../hooks/infinite-page-utils";

type InventoryItem = z.infer<typeof inventoryListItemOut>;

type InventoryListPage = {
  items: InventoryItem[];
  meta: { pageIndex: number; pageSize: number; totalCount: number };
};

export function useAllInventoryItems() {
  const pageOptions = (pageIndex: number) =>
    entityListFor("inventory").queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex, pageSize: MAX_PAGE_SIZE },
      filters: {},
    });

  const firstPageOptions = pageOptions(0);
  const query = useInfiniteQuery({
    queryKey: [...firstPageOptions.queryKey, "__all_inventory__"],
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      const options = pageOptions(pageParam);
      if (!options.queryFn) {
        throw new Error("Missing inventory list query function");
      }
      return await options.queryFn({
        queryKey: options.queryKey,
      } as never);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage: InventoryListPage) => {
      const { pageIndex, pageSize, totalCount } = lastPage.meta;
      const loaded = (pageIndex + 1) * pageSize;
      return loaded < totalCount ? pageIndex + 1 : undefined;
    },
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage({ cancelRefetch: false });
    }
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const items = useMemo(
    () => flattenUniquePageItems(query.data?.pages),
    [query.data],
  );

  return {
    ...query,
    items,
    isLoadingAll:
      query.isLoading || query.isFetchingNextPage || query.hasNextPage,
  };
}
