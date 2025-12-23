"use client";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import * as d3Hierarchy from "d3-hierarchy";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { LocationId } from "~/schemas/identifiers";
import { InfLocation, type LocationType } from "~/schemas/location";
import { LocationIcon } from "../locations/location-icons";
import Link from "next/link";

interface TreemapNode {
  name: string;
  id: LocationId;
  type: LocationType;
  value: number; // totalItemCount for sizing
  directCount: number;
  children?: TreemapNode[];
}

function transformToTreemapNode(location: InfLocation): TreemapNode {
  const children = location.children?.map(transformToTreemapNode);
  return {
    name: location.name,
    id: location.id as LocationId,
    type: location.type,
    value: location.totalItemCount ?? 0,
    directCount: location.directItemCount ?? 0,
    children: children?.length ? children : undefined,
  };
}

export default function LocationTreemap() {
  const api = useTRPC();
  const locations = useQuery(api.location.makeTree.queryOptions());
  const data = locations.data;

  const treemapData = useMemo(() => {
    if (!data || data.length === 0) return null;
    // Filter out locations with no items
    const nodesWithItems = data
      .map(transformToTreemapNode)
      .filter((n) => n.value > 0);
    if (nodesWithItems.length === 0) return null;
    return {
      name: "All Locations",
      id: "_root" as LocationId,
      type: "room" as LocationType,
      value: nodesWithItems.reduce((sum, n) => sum + n.value, 0),
      directCount: 0,
      children: nodesWithItems,
    };
  }, [data]);

  if (!treemapData) {
    return (
      <div className="text-muted-foreground flex h-[500px] items-center justify-center rounded-md border">
        No inventory items to display
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

  // Resize observer for responsive sizing
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
      .sum((d) => (d.children ? 0 : d.value)) // Only leaf nodes contribute to size
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

  // Get color based on depth - darker at root, lighter deeper
  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<TreemapNode>) => {
      const lightness = Math.min(75, 35 + node.depth * 15);
      return `hsl(220, 60%, ${lightness}%)`;
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
          const _isLeaf = !node.children;
          const isHovered = hoveredNode === node.data.id;

          // Skip root node rendering
          if (isRoot) return null;

          // Skip tiny nodes
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
              {/* Label for nodes with enough space */}
              {height > 30 && width > 60 && (
                <foreignObject
                  x={node.x0 + 4}
                  y={node.y0 + 2}
                  width={width - 8}
                  height={height - 4}
                  style={{ pointerEvents: "none" }}
                >
                  <div className="flex h-full flex-col overflow-hidden">
                    <Link
                      href={`/locations/${node.data.id}`}
                      className="flex items-center gap-1 truncate text-xs font-medium text-white drop-shadow-sm hover:underline"
                      style={{ pointerEvents: "auto" }}
                    >
                      <LocationIcon
                        type={node.data.type}
                        size={12}
                        className="shrink-0"
                      />
                      <span className="truncate">{node.data.name}</span>
                    </Link>
                    {height > 45 && (
                      <span className="mt-0.5 text-[10px] text-white/80 drop-shadow-sm">
                        {node.data.directCount > 0 && (
                          <>{node.data.directCount} items</>
                        )}
                        {node.data.directCount > 0 &&
                          node.data.value > node.data.directCount && (
                            <> ({node.data.value} total)</>
                          )}
                        {node.data.directCount === 0 && node.data.value > 0 && (
                          <>{node.data.value} items in children</>
                        )}
                      </span>
                    )}
                  </div>
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip on hover */}
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

  // Position tooltip near the hovered node
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
      <div className="text-muted-foreground mt-1">
        <div>Type: {node.data.type}</div>
        <div>Direct items: {node.data.directCount}</div>
        <div>Total items: {node.data.value}</div>
      </div>
    </div>
  );
}
