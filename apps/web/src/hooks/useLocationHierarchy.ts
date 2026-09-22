import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";

import {
  emptyPricingStatus,
  mergePricingStatus,
  type PricingStatus,
} from "~/app/_components/locations/calculate-inventory-valuation";
import { location } from "~/app/locations/location.functions";
import { useHydratedLoading } from "~/hooks/useHydrated";

// Persisted location.valuation stores pricing as bare counts; the viz nodes use
// the richer PricingStatus shape (with item-name lists for tooltips). The names
// aren't persisted, so rehydrate with empty lists — the viz only reads counts.
function toPricingStatus(
  counts:
    | { priced: number; missingPricing: number; miscNoPrice: number }
    | undefined,
): PricingStatus {
  if (!counts) return emptyPricingStatus();
  return {
    priced: { count: counts.priced, itemNames: [] },
    missingPricing: { count: counts.missingPricing, itemNames: [] },
    miscNoPrice: { count: counts.miscNoPrice, itemNames: [] },
  };
}

/**
 * Node structure for location hierarchy visualizations.
 * Used by both sunburst and treemap components.
 */
export interface LocationHierarchyNode {
  name: string;
  id: LocationShortcode;
  /** Public id — visualizations link directly to this real location. */
  shortcode: string;
  type: LocationType | null;
  /** Value used for D3 sizing - can be set based on use case */
  value: number;
  directCount: number;
  totalCount: number;
  directValuation: number;
  totalValuation: number;
  directPricingStatus: PricingStatus;
  totalPricingStatus: PricingStatus;
  children?: LocationHierarchyNode[];
}

interface UseLocationHierarchyOptions {
  /**
   * How to calculate the `value` field for leaf nodes.
   * - "itemCount": use totalCount (sunburst proportional sizing)
   * - "equalWeight": use 1 for all (treemap equal sizing)
   */
  valuationMode?: "itemCount" | "equalWeight";
}

/**
 * Hook that fetches location tree and inventory data, then transforms
 * into a hierarchical structure suitable for D3 visualizations.
 *
 * Shared between LocationSunburst and LocationTreemap.
 */
export function useLocationHierarchy(
  options: UseLocationHierarchyOptions = {},
) {
  const { valuationMode = "itemCount" } = options;

  const locations = useQuery(location.makeTree.queryOptions());
  const isLoading = useHydratedLoading(locations.isLoading);

  const hierarchyData = useMemo(() => {
    const home = locations.data?.[0];
    if (!home) return null;

    function transformNode(location: InfLocation): LocationHierarchyNode {
      const children = location.children?.map(transformNode);
      // Read the persisted rollup (location.valuation) — direct = this location,
      // total = direct + all descendants (already rolled up server-side).
      const v = location.valuation;
      const directCount = v?.directItemCount ?? location.directItemCount ?? 0;
      const directValuation = v?.directValuation ?? 0;
      const directPricingStatus = toPricingStatus(v?.direct);

      const totalCount =
        v?.totalItemCount ??
        directCount + sumBy(children ?? [], (c) => c.totalCount);
      const totalValuation =
        v?.totalValuation ??
        directValuation + sumBy(children ?? [], (c) => c.totalValuation);
      const totalPricingStatus = v
        ? toPricingStatus(v.total)
        : mergePricingStatus([
            directPricingStatus,
            ...(children?.map((c) => c.totalPricingStatus) ?? []),
          ]);

      const value =
        valuationMode === "equalWeight" ? 1 : Math.max(1, totalCount);

      return {
        name: location.name,
        id: location.id,
        shortcode: location.id,
        type: location.type,
        value,
        directCount,
        totalCount,
        directValuation,
        totalValuation,
        directPricingStatus,
        totalPricingStatus,
        children: children?.length ? children : undefined,
      };
    }

    // `makeTree` has one canonical root: the real Home Location. Keeping that
    // row as the hierarchy root makes every visual surface linkable and avoids
    // inventing a fake aggregate with a non-location shortcode.
    return transformNode(home);
  }, [locations.data, valuationMode]);

  return {
    data: isLoading ? null : hierarchyData,
    isLoading,
    isError: locations.isError,
    error: locations.error,
    refetch: locations.refetch,
  };
}
