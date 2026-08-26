import { type ImageOut, isDisplayableImageFile } from "@cubby/schemas/image";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useChunkedRecordQuery } from "~/app/_components/hooks/useChunkedRecordQuery";
import { product as productOperations } from "~/app/products/product.functions";

type ProductImageMap = Record<string, ImageOut[]>;

const ProductImageSummariesContext = createContext<ProductImageMap>({});
const EMPTY_PRODUCT_IMAGE_MAP: ProductImageMap = {};
type ProductSummaries = Awaited<
  ReturnType<typeof productOperations.summaries.call>
>;

function useProductImageSummaries(productIds: readonly string[]) {
  return useChunkedRecordQuery({
    ids: productIds,
    empty: EMPTY_PRODUCT_IMAGE_MAP,
    queryOptions: (chunkIds) => ({
      ...productOperations.summaries.queryOptions({
        ids: chunkIds,
        include: ["images"],
      }),
      enabled: chunkIds.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      select: (data: ProductSummaries) =>
        data.images ?? EMPTY_PRODUCT_IMAGE_MAP,
    }),
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
  // Drop PDF manuals (they share the images relation) so every consumer's
  // `images[0]` cover stays a real image. Memoized — a fresh map each render
  // would destabilize downstream hooks.
  const value = useMemo(() => {
    const raw = summaries ?? fetchedSummaries;
    return Object.fromEntries(
      Object.entries(raw).map(([id, imgs]) => [
        id,
        imgs.filter(isDisplayableImageFile),
      ]),
    );
  }, [summaries, fetchedSummaries]);

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

/**
 * Every hydrated image across several products, in the order the ids are given.
 * For rows that stand for a set of products rather than one (a wish and its
 * candidate alternatives), so the thumbnail's `+N` badge counts the whole set.
 */
export function useHydratedProductImagesForAll(
  productIds: readonly string[],
): ImageOut[] {
  const imageByProductId = useContext(ProductImageSummariesContext);
  return useMemo(
    () => productIds.flatMap((id) => imageByProductId[id] ?? []),
    [productIds, imageByProductId],
  );
}
