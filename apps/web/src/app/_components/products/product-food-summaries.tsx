import type { FoodSummary } from "@cubby/usda-schemas";
import { useQueries } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { ID_CHUNK_SIZE } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";

type ProductFoodMap = Record<string, FoodSummary | null>;

const ProductFoodSummariesContext = createContext<ProductFoodMap>({});
const EMPTY_PRODUCT_FOOD_MAP: ProductFoodMap = {};

const uniqueSortedIds = (ids: readonly string[]) =>
  [...new Set(ids.filter(Boolean))].sort();

export function useProductFoodSummaries(productIds: readonly string[]) {
  const api = useTRPC();
  const idsKey = useMemo(
    () => uniqueSortedIds(productIds).join(","),
    [productIds],
  );
  const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
  const idChunks = useMemo(() => chunk(ids, ID_CHUNK_SIZE), [ids]);

  return useQueries({
    queries: idChunks.map((chunkIds) =>
      api.product.foodSummaries.queryOptions(
        { ids: chunkIds },
        {
          enabled: chunkIds.length > 0,
          staleTime: 5 * 60 * 1000,
          gcTime: 30 * 60 * 1000,
        },
      ),
    ),
    combine: (results) => {
      if (results.every((result) => !result.data)) {
        return EMPTY_PRODUCT_FOOD_MAP;
      }

      return Object.assign(
        {},
        ...results.map((result) => result.data ?? EMPTY_PRODUCT_FOOD_MAP),
      );
    },
  });
}

export function ProductFoodSummariesProvider({
  productIds,
  summaries,
  children,
}: {
  productIds: readonly string[];
  summaries?: ProductFoodMap;
  children: ReactNode;
}) {
  const fetchedSummaries = useProductFoodSummaries(summaries ? [] : productIds);
  const value = summaries ?? fetchedSummaries;

  return (
    <ProductFoodSummariesContext.Provider value={value}>
      {children}
    </ProductFoodSummariesContext.Provider>
  );
}

export function useHydratedProductFood(product: {
  id: string;
  food?: FoodSummary | null;
}) {
  const foodByProductId = useContext(ProductFoodSummariesContext);
  return foodByProductId[product.id] ?? product.food ?? null;
}
