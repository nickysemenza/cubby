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

interface SunburstNode {
  name: string;
  id: LocationId;
  type: LocationType;
  value: number;
  directCount: number;
  totalCount: number;
  directValuation: number;
  totalValuation: number;
  directPricingStatus: PricingStatus;
  totalPricingStatus: PricingStatus;
  children?: SunburstNode[];
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export default function LocationSunburst() {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());

  const inventoryQuery = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 5000 },
      filters: {},
    }),
  );

  const items = useMemo(
    () => (inventoryQuery.data?.items ?? []) as InventoryItem[],
    [inventoryQuery.data],
  );

  const valuationByLocation = useAsyncMemo(
    async () => {
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

  const sunburstData = useMemo(() => {
    const data = locations.data;
    if (!data || data.length === 0) return null;

    function transformNode(location: InfLocation): SunburstNode {
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
        value: Math.max(1, totalCount), // Use totalCount for sizing, minimum 1
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
      value: totalCount || 1,
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

  if (!sunburstData) {
    return (
      <div className="text-muted-foreground flex h-[500px] items-center justify-center rounded-md border">
        No locations to display
      </div>
    );
  }

  return <Sunburst data={sunburstData} />;
}

interface SunburstProps {
  data: SunburstNode;
}

function Sunburst({ data }: SunburstProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 500, height: 500 });
  const [hoveredNode, setHoveredNode] =
    useState<d3Hierarchy.HierarchyRectangularNode<SunburstNode> | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      const size = Math.min(width, Math.max(height, 400));
      setDimensions({ width, height: size });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const size = Math.min(width, Math.max(height, 400));
        setDimensions({ width, height: size });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const radius = Math.min(dimensions.width, dimensions.height) / 2;

  const hierarchy = useMemo(() => {
    return d3Hierarchy
      .hierarchy(data)
      .sum((d) => (d.children ? 0 : d.value))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }, [data]);

  const partitionLayout = useMemo(() => {
    return d3Hierarchy.partition<SunburstNode>().size([2 * Math.PI, radius])(
      hierarchy,
    );
  }, [hierarchy, radius]);

  const nodes = useMemo(
    () => partitionLayout.descendants().filter((d) => d.depth > 0),
    [partitionLayout],
  );

  const arc = useCallback(
    (d: d3Hierarchy.HierarchyRectangularNode<SunburstNode>) => {
      const innerRadius = d.y0;
      const outerRadius = d.y1;
      const startAngle = d.x0;
      const endAngle = d.x1;

      // Create arc path
      const x0 = Math.cos(startAngle - Math.PI / 2);
      const y0 = Math.sin(startAngle - Math.PI / 2);
      const x1 = Math.cos(endAngle - Math.PI / 2);
      const y1 = Math.sin(endAngle - Math.PI / 2);

      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

      return `
        M ${innerRadius * x0} ${innerRadius * y0}
        A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${innerRadius * x1} ${innerRadius * y1}
        L ${outerRadius * x1} ${outerRadius * y1}
        A ${outerRadius} ${outerRadius} 0 ${largeArc} 0 ${outerRadius * x0} ${outerRadius * y0}
        Z
      `;
    },
    [],
  );

  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<SunburstNode>) => {
      const isEmpty = node.data.totalCount === 0;
      const lightness = Math.min(75, 35 + node.depth * 12);
      const saturation = isEmpty ? 10 : 55;
      const adjustedLightness = isEmpty ? lightness + 20 : lightness;
      return `hsl(220, ${saturation}%, ${adjustedLightness}%)`;
    },
    [],
  );

  const getLabelPosition = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<SunburstNode>) => {
      const angle = (node.x0 + node.x1) / 2;
      const r = (node.y0 + node.y1) / 2;
      const x = Math.cos(angle - Math.PI / 2) * r;
      const y = Math.sin(angle - Math.PI / 2) * r;
      const rotation = ((angle * 180) / Math.PI - 90) % 360;
      const shouldFlip = rotation > 90 && rotation < 270;
      return {
        x,
        y,
        rotation: shouldFlip ? rotation + 180 : rotation,
      };
    },
    [],
  );

  const shouldShowLabel = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<SunburstNode>) => {
      const arcLength = (node.x1 - node.x0) * ((node.y0 + node.y1) / 2);
      const arcWidth = node.y1 - node.y0;
      return arcLength > 40 && arcWidth > 20;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[500px] w-full overflow-hidden rounded-md border"
    >
      <svg width={dimensions.width} height={dimensions.height}>
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {nodes.map((node, i) => {
            const isHovered = hoveredNode?.data.id === node.data.id;
            const labelPos = getLabelPosition(node);

            return (
              <g key={i}>
                <path
                  d={arc(node)}
                  fill={getNodeColor(node)}
                  stroke={isHovered ? "hsl(var(--primary))" : "white"}
                  strokeWidth={isHovered ? 2 : 0.5}
                  className="cursor-pointer transition-opacity hover:opacity-90"
                  onMouseEnter={() => setHoveredNode(node)}
                  onMouseLeave={() => setHoveredNode(null)}
                />
                {shouldShowLabel(node) && (
                  <text
                    x={labelPos.x}
                    y={labelPos.y}
                    transform={`rotate(${labelPos.rotation}, ${labelPos.x}, ${labelPos.y})`}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className={`pointer-events-none text-[10px] font-medium ${
                      node.data.totalCount === 0
                        ? "fill-slate-600"
                        : "fill-white"
                    }`}
                    style={{ textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}
                  >
                    {node.data.name.length > 12
                      ? node.data.name.slice(0, 10) + "..."
                      : node.data.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* Center circle with summary */}
          <circle r={radius * 0.2} fill="hsl(var(--background))" />
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-foreground text-sm font-medium"
          >
            {hoveredNode ? hoveredNode.data.name : `${data.totalCount} items`}
          </text>
          {hoveredNode && (
            <text
              y={16}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted-foreground text-xs"
            >
              {hoveredNode.data.totalCount} items
            </text>
          )}
        </g>
      </svg>

      {hoveredNode && <HoverTooltip node={hoveredNode} />}
    </div>
  );
}

function HoverTooltip({
  node,
}: {
  node: d3Hierarchy.HierarchyRectangularNode<SunburstNode>;
}) {
  return (
    <div className="bg-popover pointer-events-none absolute top-4 left-4 z-50 rounded-md px-3 py-2 text-sm shadow-lg">
      <div className="flex items-center gap-2 font-medium">
        <LocationIcon type={node.data.type} size={14} />
        <Link
          href={`/locations/${node.data.id}`}
          className="hover:underline"
          style={{ pointerEvents: "auto" }}
        >
          {node.data.name}
        </Link>
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
