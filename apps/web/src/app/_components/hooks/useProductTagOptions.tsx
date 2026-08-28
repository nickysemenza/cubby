import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { product } from "~/app/products/product.functions";

const NO_TAG_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * The product tag universe as `{value,label}` options — feeds the product
 * list's Tags filter (`optionsKey: "tags"`). Mirrors `useRecipeTagOptions`,
 * except `product.tagOptions` returns usage counts, so the label carries the
 * count: with free-text tags the count is what exposes a near-duplicate
 * ("M18 (13)" next to a stray "m18 (1)") before it spreads.
 */
export function useProductTagOptions() {
  const { data, isLoading } = useQuery(product.tagOptions.queryOptions());

  const options = useMemo(
    () =>
      data?.map(({ tag, count }) => ({
        value: tag,
        label: `${tag} (${count})`,
      })) ?? NO_TAG_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
