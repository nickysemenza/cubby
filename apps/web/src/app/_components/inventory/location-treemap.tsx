"use client";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import * as d3Hierarchy from "d3-hierarchy";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { LocationId } from "~/schemas/identifiers";
import { InfLocation, type LocationType } from "~/schemas/location";
import { LocationIcon } from "../locations/location-icons";
import Link from "next/link";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import {
  type InventoryItem,
  type PricingStatus,
  emptyPricingStatus,
  mergePricingStatus,
  formatPricingStatusSummary,
  calculateInventoryValue,
} from "../locations/calculate-inventory-value";

interface TreemapNode {
  name: string;
  id: LocationId;
  type: LocationType;
  value: number; // total item count (named "value" for d3 treemap sizing)
  directCount: number;
  totalCount: number;
  directValuation: number;
  totalValuation: number;
  directPricingStatus: PricingStatus;
  totalPricingStatus: PricingStatus;
  children?: TreemapNode[];
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export default function LocationTreemap() {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());

  // Fetch inventory items for price calculation
  const inventoryQuery = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 5000 },
      filters: {},
    }),
  );

  // Extract items with stable reference
  const items = useMemo(
    () => (inventoryQuery.data?.items ?? []) as InventoryItem[],
    [inventoryQuery.data],
  );

  // Group items by location, then calculate pricing for each
  const valuationByLocation = useAsyncMemo(
    async () => {
      // Group items by location
      const itemsByLocation = new Map<string, InventoryItem[]>();
      for (const item of items) {
        const locationId = item.location.id;
        const existing = itemsByLocation.get(locationId) ?? [];
        existing.push(item);
        itemsByLocation.set(locationId, existing);
      }

      // Calculate inventory value per location using centralized function
      const resultByLocation = new Map<
        string,
        { valuation: number; pricingStatus: PricingStatus }
      >();

      for (const [locationId, locationItems] of itemsByLocation) {
        const result = await calculateInventoryValue(locationItems);
        resultByLocation.set(locationId, {
          valuation: result.totalValue,
          pricingStatus: result.pricingStatus,
        });
      }

      return resultByLocation;
    },
    [items],
    new Map<string, { valuation: number; pricingStatus: PricingStatus }>(),
  );

  const treemapData = useMemo(() => {
    const data = locations.data;
    if (!data || data.length === 0) return null;

    function transformNode(location: InfLocation): TreemapNode {
      const children = location.children?.map(transformNode);
      const directCount = location.directItemCount ?? 0;
      const locationData = valuationByLocation.get(location.id);
      const directValuation = locationData?.valuation ?? 0;
      const directPricingStatus =
        locationData?.pricingStatus ?? emptyPricingStatus();

      const childrenCount =
        children?.reduce((sum, c) => sum + c.totalCount, 0) ?? 0;
      const childrenValuation =
        children?.reduce((sum, c) => sum + c.totalValuation, 0) ?? 0;
      const childrenPricingStatuses =
        children?.map((c) => c.totalPricingStatus) ?? [];

      const totalCount = directCount + childrenCount;
      const totalValuation = directValuation + childrenValuation;
      const totalPricingStatus = mergePricingStatus([
        directPricingStatus,
        ...childrenPricingStatuses,
      ]);

      return {
        name: location.name,
        id: location.id as LocationId,
        type: location.type,
        value: 1, // equal sizing - all locations get same weight
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

    const totalCount = allNodes.reduce((sum, n) => sum + n.totalCount, 0);
    const totalValuation = allNodes.reduce(
      (sum, n) => sum + n.totalValuation,
      0,
    );
    const totalPricingStatus = mergePricingStatus(
      allNodes.map((n) => n.totalPricingStatus),
    );
    return {
      name: "All Locations",
      id: "_root" as LocationId,
      type: "room" as LocationType,
      value: allNodes.length, // root value = number of children
      directCount: 0,
      totalCount,
      directValuation: 0,
      totalValuation,
      directPricingStatus: emptyPricingStatus(),
      totalPricingStatus,
      children: allNodes,
    };
  }, [locations.data, valuationByLocation]);

  if (locations.isLoading || inventoryQuery.isLoading) {
    return (
      <div className="text-muted-foreground flex h-[500px] items-center justify-center rounded-md border">
        Loading inventory data...
      </div>
    );
  }

  if (!treemapData) {
    return (
      <div className="text-muted-foreground flex h-[500px] items-center justify-center rounded-md border">
        No locations to display
      </div>
    );
  }

  return <Treemap data={treemapData} />;
}

interface TreemapProps {
  data: TreemapNode;
}

function Treemap({ data }: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDimensions({ width, height: Math.max(height, 400) });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height: Math.max(height, 400) });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const hierarchy = useMemo(() => {
    return d3Hierarchy
      .hierarchy(data)
      .sum((d) => (d.children ? 0 : d.value))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }, [data]);

  const treemapLayout = useMemo(() => {
    return d3Hierarchy
      .treemap<TreemapNode>()
      .size([dimensions.width, dimensions.height])
      .paddingOuter(4)
      .paddingTop(24)
      .paddingInner(2)
      .round(true)(hierarchy);
  }, [hierarchy, dimensions]);

  const nodes = useMemo(() => treemapLayout.descendants(), [treemapLayout]);

  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<TreemapNode>) => {
      const isEmpty = node.data.totalCount === 0;
      const lightness = Math.min(75, 35 + node.depth * 15);
      // Gray out empty locations
      const saturation = isEmpty ? 10 : 55;
      const adjustedLightness = isEmpty ? lightness + 20 : lightness;
      return `hsl(220, ${saturation}%, ${adjustedLightness}%)`;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[500px] w-full overflow-hidden rounded-md border"
    >
      <svg width={dimensions.width} height={dimensions.height}>
        {nodes.map((node, i) => {
          const width = node.x1 - node.x0;
          const height = node.y1 - node.y0;
          const isRoot = node.depth === 0;
          const isHovered = hoveredNode === node.data.id;

          if (isRoot) return null;
          if (width < 20 || height < 20) return null;

          return (
            <g key={i}>
              <rect
                x={node.x0}
                y={node.y0}
                width={width}
                height={height}
                fill={getNodeColor(node)}
                stroke={isHovered ? "hsl(var(--primary))" : "white"}
                strokeWidth={isHovered ? 2 : 1}
                rx={4}
                className="cursor-pointer transition-opacity hover:opacity-90"
                onMouseEnter={() => setHoveredNode(node.data.id)}
                onMouseLeave={() => setHoveredNode(null)}
              />
              {height > 24 && (
                <foreignObject
                  x={node.x0 + 4}
                  y={node.y0 + 2}
                  width={width - 8}
                  height={height - 4}
                  style={{ pointerEvents: "none" }}
                >
                  <div className="flex h-full flex-col overflow-hidden">
                    <div
                      className={`flex items-center gap-1 text-xs ${
                        node.data.totalCount === 0
                          ? "text-slate-600"
                          : "text-white drop-shadow-sm"
                      }`}
                    >
                      <Link
                        href={`/locations/${node.data.id}`}
                        className="flex min-w-0 items-center gap-1 font-medium hover:underline"
                        style={{ pointerEvents: "auto" }}
                      >
                        <LocationIcon
                          type={node.data.type}
                          size={12}
                          className="shrink-0"
                        />
                        <span className="truncate">{node.data.name}</span>
                      </Link>
                      {width > 160 && node.data.totalCount > 0 && (
                        <span className="shrink-0 text-[10px] text-white/80">
                          · {node.data.totalCount}
                        </span>
                      )}
                      {width > 220 && node.data.totalValuation > 0 && (
                        <span className="shrink-0 text-[10px] text-white/80">
                          · {currency.format(node.data.totalValuation)}
                          {(node.data.totalPricingStatus.missingPricing.count >
                            0 ||
                            node.data.totalPricingStatus.miscNoPrice.count >
                              0) && (
                            <span className="text-white/60">
                              {" "}
                              (
                              {node.data.totalPricingStatus.missingPricing
                                .count +
                                node.data.totalPricingStatus.miscNoPrice
                                  .count}{" "}
                              unpriced)
                            </span>
                          )}
                        </span>
                      )}
                      {width > 120 && node.data.totalCount === 0 && (
                        <span className="shrink-0 text-[10px] text-slate-500">
                          · empty
                        </span>
                      )}
                    </div>
                  </div>
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>

      {hoveredNode && <HoverTooltip nodes={nodes} hoveredId={hoveredNode} />}
    </div>
  );
}

function HoverTooltip({
  nodes,
  hoveredId,
}: {
  nodes: d3Hierarchy.HierarchyRectangularNode<TreemapNode>[];
  hoveredId: string;
}) {
  const node = nodes.find((n) => n.data.id === hoveredId);
  if (!node) return null;

  const x = Math.min(node.x0 + 10, window.innerWidth - 200);
  const y = node.y0 + 30;

  return (
    <div
      className="bg-popover pointer-events-none absolute z-50 rounded-md px-3 py-2 text-sm shadow-lg"
      style={{ left: x, top: y }}
    >
      <div className="flex items-center gap-2 font-medium">
        <LocationIcon type={node.data.type} size={14} />
        {node.data.name}
      </div>
      <div className="text-muted-foreground mt-1 space-y-0.5">
        <div>Type: {node.data.type}</div>
        <div>
          Items: {node.data.directCount} direct / {node.data.totalCount} total
        </div>
        {(node.data.directValuation > 0 || node.data.totalValuation > 0) && (
          <div>
            Value: {currency.format(node.data.directValuation)} direct /{" "}
            {currency.format(node.data.totalValuation)} total
          </div>
        )}
        {(() => {
          const summary = formatPricingStatusSummary(
            node.data.totalPricingStatus,
          );
          return summary ? <div>{summary}</div> : null;
        })()}
      </div>
    </div>
  );
}
