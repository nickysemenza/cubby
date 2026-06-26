import type { ImageOut } from "@cubby/schemas/image";
import { useQueries } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { ID_CHUNK_SIZE } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";

type ProductImageMap = Record<string, ImageOut[]>;

const ProductImageSummariesContext = createContext<ProductImageMap>({});
const EMPTY_PRODUCT_IMAGE_MAP: ProductImageMap = {};

const uniqueSortedIds = (ids: readonly string[]) =>
  [...new Set(ids.filter(Boolean))].sort();

function useProductImageSummaries(productIds: readonly string[]) {
  const api = useTRPC();
  const idsKey = useMemo(
    () => uniqueSortedIds(productIds).join(","),
    [productIds],
  );
  const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
  const idChunks = useMemo(() => chunk(ids, ID_CHUNK_SIZE), [ids]);

  return useQueries({
    queries: idChunks.map((chunkIds) =>
      api.product.imageSummaries.queryOptions(
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
        return EMPTY_PRODUCT_IMAGE_MAP;
      }

      return Object.assign(
        {},
        ...results.map((result) => result.data ?? EMPTY_PRODUCT_IMAGE_MAP),
      );
    },
  });
}

export function ProductImageSummariesProvider({
  productIds,
  summaries,
  children,
}: {
  productIds: readonly string[];
  summaries?: ProductImageMap;
  children: ReactNode;
}) {
  const fetchedSummaries = useProductImageSummaries(
    summaries ? [] : productIds,
  );
  const value = summaries ?? fetchedSummaries;

  return (
    <ProductImageSummariesContext.Provider value={value}>
      {children}
    </ProductImageSummariesContext.Provider>
  );
}

export function useHydratedProductImages(productId: string) {
  const imageByProductId = useContext(ProductImageSummariesContext);
  return imageByProductId[productId] ?? [];
}
