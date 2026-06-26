import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQueries } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import { useMemo } from "react";
import { ID_CHUNK_SIZE } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";

export type ProductUnitMappingMap = Record<string, UnitMapping[]>;

const EMPTY_PRODUCT_UNIT_MAPPING_MAP: ProductUnitMappingMap = {};

const uniqueSortedIds = (ids: readonly string[]) =>
  [...new Set(ids.filter(Boolean))].sort();

export function useProductUnitMappingSummaries(productIds: readonly string[]) {
  const api = useTRPC();
  const idsKey = useMemo(
    () => uniqueSortedIds(productIds).join(","),
    [productIds],
  );
  const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
  const idChunks = useMemo(() => chunk(ids, ID_CHUNK_SIZE), [ids]);

  const results = useQueries({
    queries: idChunks.map((chunkIds) =>
      api.product.unitMappingSummaries.queryOptions(
        { ids: chunkIds },
        {
          enabled: chunkIds.length > 0,
          staleTime: 5 * 60 * 1000,
          gcTime: 30 * 60 * 1000,
        },
      ),
    ),
  });

  return useMemo(() => {
    if (results.every((result) => !result.data)) {
      return EMPTY_PRODUCT_UNIT_MAPPING_MAP;
    }

    return Object.assign(
      {},
      ...results.map((result) => result.data ?? EMPTY_PRODUCT_UNIT_MAPPING_MAP),
    );
  }, [results]);
}
