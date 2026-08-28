import type { UnitMapping } from "@cubby/schemas/unitmapping";

import { useChunkedRecordQuery } from "~/app/_components/hooks/useChunkedRecordQuery";
import { product as productOperations } from "~/app/products/product.functions";

type ProductUnitMappingMap = Record<string, UnitMapping[]>;

const EMPTY_PRODUCT_UNIT_MAPPING_MAP: ProductUnitMappingMap = {};
type ProductSummaries = Awaited<
  ReturnType<typeof productOperations.summaries.call>
>;

export function useProductUnitMappingSummaries(productIds: readonly string[]) {
  return useChunkedRecordQuery({
    ids: productIds,
    empty: EMPTY_PRODUCT_UNIT_MAPPING_MAP,
    queryOptions: (chunkIds) => ({
      ...productOperations.summaries.queryOptions({
        ids: chunkIds,
        include: ["unitMappings"],
      }),
      enabled: chunkIds.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      select: (data: ProductSummaries) =>
        data.unitMappings ?? EMPTY_PRODUCT_UNIT_MAPPING_MAP,
    }),
  });
}
