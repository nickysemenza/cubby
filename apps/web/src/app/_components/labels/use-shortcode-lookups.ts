import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { location } from "~/app/locations/location.functions";
import { product } from "~/app/products/product.functions";

import type { LabelItem } from "./sheet-layouts";

// Stable fallback for disabled queries: an inline `= []` default creates a new
// reference every render, which destabilizes the `items` memo and loops the QR
// effect in useQrUrls (infinite re-render when only one entity type is present).
const NO_ROWS: never[] = [];

export function useShortcodeLookups(shortcodes: string[]) {
  // Group shortcodes by entity type
  const { locationCodes, productCodes } = useMemo(() => {
    const locs: string[] = [];
    const prods: string[] = [];
    for (const code of shortcodes) {
      const parsed = parseShortcode(code);
      if (parsed?.type === "location") locs.push(code);
      else if (parsed?.type === "product") prods.push(code);
    }
    return { locationCodes: locs, productCodes: prods };
  }, [shortcodes]);

  // Batch fetch: one query per entity type instead of N individual queries
  const {
    data: locationData = NO_ROWS,
    isLoading: locationsLoading,
    error: locationsError,
    refetch: refetchLocations,
  } = useQuery({
    ...location.getByShortcodes.queryOptions({
      shortcodes: locationCodes,
    }),
    enabled: locationCodes.length > 0,
  });

  const {
    data: productData = NO_ROWS,
    isLoading: productsLoading,
    error: productsError,
    refetch: refetchProducts,
  } = useQuery({
    ...product.getByShortcodes.queryOptions({ shortcodes: productCodes }),
    enabled: productCodes.length > 0,
  });

  const items: LabelItem[] = useMemo(() => {
    const locs = locationData.map((d) => ({
      shortcode: d.id,
      name: d.name,
      entityType: "location" as const,
      locationType: d.type ?? undefined,
      parentName: d.parentName,
    }));
    const prods = productData.map((d) => ({
      shortcode: d.id,
      name: d.name,
      entityType: "product" as const,
      productCategory: d.category,
    }));
    return [...locs, ...prods];
  }, [locationData, productData]);

  const isLoading = locationsLoading || productsLoading;
  const error = locationsError ?? productsError;
  const refetch = async () => {
    await Promise.all([refetchLocations(), refetchProducts()]);
  };

  return { items, isLoading, error, refetch };
}
