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
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { convertAmountToPrice } from "~/app/_components/units/univ-conversion";
import { type InventoryItem } from "../locations/calculate-inventory-value";

interface TreemapNode {
  name: string;
  id: LocationId;
  type: LocationType;
  value: number; // total item count (named "value" for d3 treemap sizing)
  directCount: number;
  totalCount: number;
  directValuation: number; // price value for items directly in this location
  totalValuation: number; // total price including children
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

  // Calculate price values for each location
  const valuationByLocation = useAsyncMemo(
    async () => {
      const valueByLocationId = new Map<string, number>();

      for (const item of items) {
        const mappings = await getAllUnitMappingsFromProduct(item.product);
        const priceRes = convertAmountToPrice(item.amount, mappings);
        if (priceRes.success) {
          const val = priceRes.value.value || 0;
          if (val > 0) {
            const locationId = item.location.id;
            const current = valueByLocationId.get(locationId) ?? 0;
            valueByLocationId.set(locationId, current + val);
          }
        }
      }

      return valueByLocationId;
    },
    [items],
    new Map<string, number>(),
  );

  const treemapData = useMemo(() => {
    const data = locations.data;
    if (!data || data.length === 0) return null;

    function transformNode(location: InfLocation): TreemapNode {
      const children = location.children?.map(transformNode);
      const directCount = location.directItemCount ?? 0;
      const directValuation = valuationByLocation.get(location.id) ?? 0;

      const childrenCount =
        children?.reduce((sum, c) => sum + c.totalCount, 0) ?? 0;
      const childrenValuation =
        children?.reduce((sum, c) => sum + c.totalValuation, 0) ?? 0;

      const totalCount = directCount + childrenCount;
      const totalValuation = directValuation + childrenValuation;

      return {
        name: location.name,
        id: location.id as LocationId,
        type: location.type,
        value: totalCount, // sizing always by count
        directCount,
        totalCount,
        directValuation,
        totalValuation,
        children: children?.length ? children : undefined,
      };
    }

    const allNodes = data.map(transformNode);
    if (allNodes.length === 0) return null;

    // Give empty locations a small value so they show up (but smaller)
    const nodesWithMinValue = allNodes.map((n) => ({
      ...n,
      value: Math.max(n.totalCount, 0.5), // minimum value for visibility
    }));

    const totalCount = nodesWithMinValue.reduce(
      (sum, n) => sum + n.totalCount,
      0,
    );
    const totalValuation = nodesWithMinValue.reduce(
      (sum, n) => sum + n.totalValuation,
      0,
    );
    return {
      name: "All Locations",
      id: "_root" as LocationId,
      type: "room" as LocationType,
      value: nodesWithMinValue.reduce((sum, n) => sum + n.value, 0),
      directCount: 0,
      totalCount,
      directValuation: 0,
      totalValuation,
      children: nodesWithMinValue,
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
              {height > 30 && width > 60 && (
                <foreignObject
                  x={node.x0 + 4}
                  y={node.y0 + 2}
                  width={width - 8}
                  height={height - 4}
                  style={{ pointerEvents: "none" }}
                >
                  <div className="flex h-full flex-col overflow-hidden">
                    <div className="flex items-center gap-1 text-xs text-white drop-shadow-sm">
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
                      {width > 140 && node.data.totalCount > 0 && (
                        <span className="shrink-0 text-[10px] text-white/80">
                          · {node.data.totalCount}
                          {width > 200 && node.data.totalValuation > 0 && (
                            <> · {currency.format(node.data.totalValuation)}</>
                          )}
                        </span>
                      )}
                      {width > 100 && node.data.totalCount === 0 && (
                        <span className="shrink-0 text-[10px] text-white/60">
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
      </div>
    </div>
  );
}
