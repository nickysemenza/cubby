import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";
import {
  calculateInventoryValuation,
  emptyPricingStatus,
  type InventoryItem,
  mergePricingStatus,
  type PricingStatus,
} from "~/app/_components/locations/calculate-inventory-valuation";
import { ROOT_LOCATION_ID } from "~/hooks/useLocationTree";
import { useTRPC } from "~/trpc/react";

/**
 * Node structure for location hierarchy visualizations.
 * Used by both sunburst and treemap components.
 */
export interface LocationHierarchyNode {
  name: string;
  id: LocationId;
  type: LocationType;
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

interface UseLocationHierarchyResult {
  data: LocationHierarchyNode | null;
  isLoading: boolean;
}

/**
 * Hook that fetches location tree and inventory data, then transforms
 * into a hierarchical structure suitable for D3 visualizations.
 *
 * Shared between LocationSunburst and LocationTreemap.
 */
export function useLocationHierarchy(
  options: UseLocationHierarchyOptions = {},
): UseLocationHierarchyResult {
  const { valuationMode = "itemCount" } = options;

  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());

  const inventoryQuery = useQuery(
    api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 5000 },
      filters: {},
    }),
  );

  const items = useMemo(
    () => (inventoryQuery.data?.items ?? []) as InventoryItem[],
    [inventoryQuery.data],
  );

  // Group items by location and calculate valuations synchronously
  const valuationByLocation = useMemo(() => {
    const itemsByLocation = new Map<string, InventoryItem[]>();
    for (const item of items) {
      const locationId = item.location.id;
      const existing = itemsByLocation.get(locationId) ?? [];
      existing.push(item);
      itemsByLocation.set(locationId, existing);
    }

    const resultByLocation = new Map<
      string,
      { valuation: number; pricingStatus: PricingStatus }
    >();

    for (const [locationId, locationItems] of itemsByLocation) {
      // Synchronous calculation using precomputed valuation column
      const result = calculateInventoryValuation(locationItems);
      resultByLocation.set(locationId, {
        valuation: result.totalValuation,
        pricingStatus: result.pricingStatus,
      });
    }

    return resultByLocation;
  }, [items]);

  const hierarchyData = useMemo(() => {
    const data = locations.data;
    if (!data || data.length === 0) return null;

    function transformNode(location: InfLocation): LocationHierarchyNode {
      const children = location.children?.map(transformNode);
      const directCount = location.directItemCount ?? 0;
      const locationData = valuationByLocation.get(location.id);
      const directValuation = locationData?.valuation ?? 0;
      const directPricingStatus =
        locationData?.pricingStatus ?? emptyPricingStatus();

      const childrenCount = sumBy(children ?? [], (c) => c.totalCount);
      const childrenValuation = sumBy(children ?? [], (c) => c.totalValuation);
      const childrenPricingStatuses =
        children?.map((c) => c.totalPricingStatus) ?? [];

      const totalCount = directCount + childrenCount;
      const totalValuation = directValuation + childrenValuation;
      const totalPricingStatus = mergePricingStatus([
        directPricingStatus,
        ...childrenPricingStatuses,
      ]);

      // Calculate value based on mode
      const value =
        valuationMode === "equalWeight" ? 1 : Math.max(1, totalCount);

      return {
        name: location.name,
        id: location.id,
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

    const allNodes = data.map(transformNode);
    if (allNodes.length === 0) return null;

    const totalCount = sumBy(allNodes, (n) => n.totalCount);
    const totalValuation = sumBy(allNodes, (n) => n.totalValuation);
    const totalPricingStatus = mergePricingStatus(
      allNodes.map((n) => n.totalPricingStatus),
    );

    return {
      name: "All Locations",
      id: ROOT_LOCATION_ID,
      type: "room" as LocationType,
      value:
        valuationMode === "equalWeight" ? allNodes.length : totalCount || 1,
      directCount: 0,
      totalCount,
      directValuation: 0,
      totalValuation,
      directPricingStatus: emptyPricingStatus(),
      totalPricingStatus,
      children: allNodes,
    };
  }, [locations.data, valuationByLocation, valuationMode]);

  return {
    data: hierarchyData,
    isLoading: locations.isLoading || inventoryQuery.isLoading,
  };
}
