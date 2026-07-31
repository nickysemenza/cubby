import { Link } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import { useCallback, useMemo, useRef, useState } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import {
  type LocationHierarchyNode,
  useLocationHierarchy,
} from "~/hooks/useLocationHierarchy";
import { formatCurrency } from "~/lib/utils";
import { formatPricingStatusSummary } from "../locations/calculate-inventory-valuation";
import { LocationTypeLabel } from "../locations/LocationTypeLabel";
import { LocationIcon } from "../locations/location-icons";
import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizTooltip } from "./viz-overlay";

export default function LocationSunburst() {
  const { data, isLoading } = useLocationHierarchy({
    valuationMode: "itemCount",
  });

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading inventory data..."
        height={500}
      />
    );
  }

  if (!data) {
    return (
      <VisualizationPlaceholder
        message="No locations to display"
        height={500}
      />
    );
  }

  return <Sunburst data={data} />;
}

interface SunburstProps {
  data: LocationHierarchyNode;
}

function Sunburst({ data }: SunburstProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 400,
    initialWidth: 500,
    initialHeight: 500,
  });
  const [hoveredNode, setHoveredNode] =
    useState<d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode> | null>(
      null,
    );

  const radius = Math.min(dimensions.width, dimensions.height) / 2;

  const hierarchy = useMemo(() => {
    return d3Hierarchy
      .hierarchy(data)
      .sum((d) => (d.children ? 0 : d.value))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }, [data]);

  const partitionLayout = useMemo(() => {
    return d3Hierarchy
      .partition<LocationHierarchyNode>()
      .size([2 * Math.PI, radius])(hierarchy);
  }, [hierarchy, radius]);

  const nodes = useMemo(
    () => partitionLayout.descendants().filter((d) => d.depth > 0),
    [partitionLayout],
  );

  const arc = useCallback(
    (d: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) => {
      const innerRadius = d.y0;
      const outerRadius = d.y1;
      const startAngle = d.x0;
      const endAngle = d.x1;

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

  // Sequential ink ramp (paper -> ultramarine) by depth: the root ring burns
  // deepest and each nested ring lightens toward paper. Empty locations sit out
  // in muted.
  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) => {
      if (node.data.totalCount === 0) return "var(--muted)";
      const ramp = [
        "var(--chart-seq-5)",
        "var(--chart-seq-4)",
        "var(--chart-seq-3)",
        "var(--chart-seq-2)",
        "var(--chart-seq-1)",
      ];
      return ramp[Math.min(node.depth - 1, ramp.length - 1)] ?? ramp[0];
    },
    [],
  );
  // Deep rings need paper-colored ink; shallow rings read with the foreground.
  const isDeepRing = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) =>
      node.data.totalCount > 0 && node.depth <= 2,
    [],
  );

  const getLabelPosition = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) => {
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
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) => {
      const arcLength = (node.x1 - node.x0) * ((node.y0 + node.y1) / 2);
      const arcWidth = node.y1 - node.y0;
      return arcLength > 40 && arcWidth > 20;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[500px] w-full overflow-hidden rounded-md border border-[var(--border)]"
    >
      <svg
        aria-hidden="true"
        width={dimensions.width}
        height={dimensions.height}
      >
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {nodes.map((node) => {
            const isHovered = hoveredNode?.data.id === node.data.id;
            const labelPos = getLabelPosition(node);

            return (
              <g key={node.data.id}>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: D3 sunburst visualization hover interaction */}
                <path
                  d={arc(node)}
                  fill={getNodeColor(node)}
                  stroke={isHovered ? "var(--primary)" : "var(--background)"}
                  strokeWidth={isHovered ? 2 : 1}
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
                    className="pointer-events-none font-medium text-2xs"
                    fill={
                      node.data.totalCount === 0
                        ? "var(--muted-foreground)"
                        : isDeepRing(node)
                          ? "var(--background)"
                          : "var(--foreground)"
                    }
                  >
                    {node.data.name.length > 12
                      ? `${node.data.name.slice(0, 10)}...`
                      : node.data.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* Center circle with summary */}
          <circle r={radius * 0.2} fill="var(--background)" />
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-foreground font-medium text-sm"
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
  node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>;
}) {
  return (
    <VizTooltip>
      <div className="flex items-center gap-2 font-medium">
        <LocationIcon type={node.data.type} size={14} />
        {node.data.shortcode ? (
          <Link
            to="/locations/$shortcode"
            params={{ shortcode: node.data.shortcode }}
            className="hover:underline"
            style={{ pointerEvents: "auto" }}
          >
            {node.data.name}
          </Link>
        ) : (
          // The synthetic "All Locations" root has no row behind it.
          <span>{node.data.name}</span>
        )}
      </div>
      <div className="mt-1 space-y-1 text-muted-foreground">
        <LocationTypeLabel type={node.data.type} />
        <div>
          Items: {node.data.directCount} direct / {node.data.totalCount} total
        </div>
        {(node.data.directValuation > 0 || node.data.totalValuation > 0) && (
          <div>
            Value: {formatCurrency(node.data.directValuation, 0)} direct /{" "}
            {formatCurrency(node.data.totalValuation, 0)} total
          </div>
        )}
        {(() => {
          const summary = formatPricingStatusSummary(
            node.data.totalPricingStatus,
          );
          return summary ? <div>{summary}</div> : null;
        })()}
      </div>
    </VizTooltip>
  );
}
