import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";
import type { LabelItem } from "./sheet-layouts";

// Stable fallback for disabled queries: an inline `= []` default creates a new
// reference every render, which destabilizes the `items` memo and loops the QR
// effect in useQrUrls (infinite re-render when only one entity type is present).
const NO_ROWS: never[] = [];

export function useShortcodeLookups(shortcodes: string[]) {
  const api = useTRPC();

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
  const { data: locationData = NO_ROWS, isLoading: locationsLoading } =
    useQuery({
      ...api.location.getByShortcodes.queryOptions({
        shortcodes: locationCodes,
      }),
      enabled: locationCodes.length > 0,
    });

  const { data: productData = NO_ROWS, isLoading: productsLoading } = useQuery({
    ...api.product.getByShortcodes.queryOptions({ shortcodes: productCodes }),
    enabled: productCodes.length > 0,
  });

  const items: LabelItem[] = useMemo(() => {
    const locs = locationData.map((d) => ({
      shortcode: d.shortcode,
      name: d.name,
      entityType: "location" as const,
      locationType: d.type,
      parentName: d.parentName,
    }));
    const prods = productData.map((d) => ({
      shortcode: d.shortcode,
      name: d.name,
      entityType: "product" as const,
      productCategory: d.category,
    }));
    return [...locs, ...prods];
  }, [locationData, productData]);

  const isLoading = locationsLoading || productsLoading;

  return { items, isLoading };
}
