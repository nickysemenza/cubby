import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/trpc/react";
import type { LabelItem } from "./sheet-layouts";

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
  const { data: locationData = [], isLoading: locationsLoading } = useQuery({
    ...api.location.getByShortcodes.queryOptions({ shortcodes: locationCodes }),
    enabled: locationCodes.length > 0,
  });

  const { data: productData = [], isLoading: productsLoading } = useQuery({
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
