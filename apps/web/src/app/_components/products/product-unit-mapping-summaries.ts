import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useChunkedRecordQuery } from "~/app/_components/hooks/useChunkedRecordQuery";
import { productSummariesQueryOptions } from "~/app/products/product.functions";

type ProductUnitMappingMap = Record<string, UnitMapping[]>;

const EMPTY_PRODUCT_UNIT_MAPPING_MAP: ProductUnitMappingMap = {};

export function useProductUnitMappingSummaries(productIds: readonly string[]) {
  return useChunkedRecordQuery({
    ids: productIds,
    empty: EMPTY_PRODUCT_UNIT_MAPPING_MAP,
    queryOptions: (chunkIds) =>
      productSummariesQueryOptions(
        { ids: chunkIds, include: ["unitMappings"] },
        {
          enabled: chunkIds.length > 0,
          staleTime: 5 * 60 * 1000,
          gcTime: 30 * 60 * 1000,
          select: (data) => data.unitMappings ?? EMPTY_PRODUCT_UNIT_MAPPING_MAP,
        },
      ),
  });
}
