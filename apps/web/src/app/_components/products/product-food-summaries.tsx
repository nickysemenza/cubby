import type { FoodSummary } from "@cubby/usda-schemas";
import { createContext, type ReactNode, useContext } from "react";
import { useChunkedRecordQuery } from "~/app/_components/hooks/useChunkedRecordQuery";
import { useTRPC } from "~/integrations/trpc/react";

type ProductFoodMap = Record<string, FoodSummary | null>;

const ProductFoodSummariesContext = createContext<ProductFoodMap>({});
const EMPTY_PRODUCT_FOOD_MAP: ProductFoodMap = {};

export function useProductFoodSummaries(productIds: readonly string[]) {
  const api = useTRPC();
  return useChunkedRecordQuery({
    ids: productIds,
    empty: EMPTY_PRODUCT_FOOD_MAP,
    queryOptions: (chunkIds) =>
      api.product.summaries.queryOptions(
        { ids: chunkIds, include: ["food"] },
        {
          enabled: chunkIds.length > 0,
          staleTime: 5 * 60 * 1000,
          gcTime: 30 * 60 * 1000,
          select: (data) => data.food ?? EMPTY_PRODUCT_FOOD_MAP,
        },
      ),
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
