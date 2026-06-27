import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useChunkedRecordQuery } from "~/app/_components/hooks/useChunkedRecordQuery";
import { useTRPC } from "~/trpc/react";

type ProductUnitMappingMap = Record<string, UnitMapping[]>;

const EMPTY_PRODUCT_UNIT_MAPPING_MAP: ProductUnitMappingMap = {};

export function useProductUnitMappingSummaries(productIds: readonly string[]) {
  const api = useTRPC();
  return useChunkedRecordQuery({
    ids: productIds,
    empty: EMPTY_PRODUCT_UNIT_MAPPING_MAP,
    queryOptions: (chunkIds) =>
      api.product.unitMappingSummaries.queryOptions(
        { ids: chunkIds },
        {
          enabled: chunkIds.length > 0,
          staleTime: 5 * 60 * 1000,
          gcTime: 30 * 60 * 1000,
        },
      ),
  });
}
