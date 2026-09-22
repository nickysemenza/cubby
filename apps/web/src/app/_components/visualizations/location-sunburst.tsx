import { Link } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import {
  type LocationHierarchyNode,
  useLocationHierarchy,
} from "~/hooks/useLocationHierarchy";
import { getAppErrorDetails } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";

import { formatPricingStatusSummary } from "../locations/calculate-inventory-valuation";
import { LocationIcon } from "../locations/location-icons";
import { LocationTypeLabel } from "../locations/LocationTypeLabel";
import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizTooltip } from "./viz-overlay";

// Which ring fills need light-on-dark labels vs dark-on-light labels, sized
// against the actual WCAG contrast ratios for these tokens: chart-2/3/4 clear
// 4.5:1 only against white (chart-4 vs the paper token lands at 4.42:1, just
// under), while chart-5/6 clear 4.5:1 against ink. See the identical table in
// product-category-donut.tsx, derived once against the known oklch values in
// styles.css rather than a runtime lightness read.
const DARK_RING_FILLS = new Set([
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
]);

export const LOCATION_SUNBURST_METRIC = "itemCount" as const;
export const LOCATION_SUNBURST_DESCRIPTION =
  "How owned-item counts are distributed across your locations.";

export default function LocationSunburst() {
  const { data, error, isError, isLoading, refetch } = useLocationHierarchy({
    valuationMode: LOCATION_SUNBURST_METRIC,
  });

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading inventory data..."
        height={500}
      />
    );
  }

  if (isError) {
    return (
      <VisualizationPlaceholder
        message="Inventory locations are unavailable"
        subMessage={getAppErrorDetails(error).message}
        height={500}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data || data.totalCount === 0) {
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
  const summaryId = useId();
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

  const nodes = useMemo(() => partitionLayout.descendants(), [partitionLayout]);

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

  // Sequential ink ramp (dark ink -> light ink) by depth: the root ring reads
  // heaviest and each nested ring lightens. The old ramp (--chart-seq-1..5)
  // is an ultramarine tint sequence, so it painted the whole hierarchy in the
  // interaction accent — the One Loud Thing rule (DESIGN.md) reserves that
  // color for a single live/interactive value, not a whole panel. Empty
  // locations sit out in muted.
  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) => {
      if (node.data.totalCount === 0) return "var(--muted)";
      const ramp = [
        "var(--chart-2)",
        "var(--chart-3)",
        "var(--chart-4)",
        "var(--chart-5)",
        "var(--chart-6)",
      ];
      // Fallback is unreachable (index is clamped into range) but keeps the
      // return type a definite `string` for DARK_RING_FILLS.has() below.
      return (
        ramp[Math.min(Math.max(0, node.depth), ramp.length - 1)] ??
        "var(--chart-6)"
      );
    },
    [],
  );
  // Which rings need paper/white-colored ink vs. the foreground — derived from
  // the fill itself (DARK_RING_FILLS) rather than depth, since chart-4 needs
  // white specifically (see the table above getNodeColor / DARK_RING_FILLS).
  const isDarkRing = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) =>
      node.data.totalCount > 0 && DARK_RING_FILLS.has(getNodeColor(node)),
    [getNodeColor],
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

  // Top-level locations arrive pre-sorted desc by value (hierarchy.sort in the
  // useMemo above), so the first few depth-1 nodes are already the chart's
  // leading values.
  const chartSummary = useMemo(() => {
    const top = nodes
      .filter((n) => n.depth === 1)
      .slice(0, 3)
      .map((n) => `${n.data.name} ${n.data.totalCount}`)
      .join("; ");
    return `Inventory by location: ${top}; ${data.totalCount} items total`;
  }, [nodes, data.totalCount]);

  const topLocations = useMemo(() => {
    const topLevel = nodes.filter((node) => node.depth === 1);
    return (
      topLevel.length > 0 ? topLevel : nodes.filter((node) => node.depth === 0)
    )
      .slice(0, 3)
      .filter((node) => node.data.totalCount > 0);
  }, [nodes]);

  return (
    <div
      ref={containerRef}
      className="relative h-[500px] w-full overflow-hidden border border-[var(--border)]"
    >
      <svg
        aria-label={chartSummary}
        aria-describedby={summaryId}
        width={dimensions.width}
        height={dimensions.height}
      >
        <title>{chartSummary}</title>
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {nodes.map((node) => {
            const isHovered = hoveredNode?.data.id === node.data.id;
            const labelPos = getLabelPosition(node);

            return (
              <g key={node.data.id}>
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
                    className="pointer-events-none text-2xs font-medium"
                    fill={
                      node.data.totalCount === 0
                        ? "var(--muted-foreground)"
                        : isDarkRing(node)
                          ? "var(--primary-foreground)"
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

      <p id={summaryId} className="sr-only">
        {chartSummary}. Use the location links below to open a location.
      </p>

      {topLocations.length > 0 && (
        <nav
          aria-label="Top inventory locations"
          className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1 border border-[var(--border)] bg-background/95 p-1"
        >
          {topLocations.map((node) => (
            <Link
              key={node.data.id}
              to="/locations/$shortcode"
              params={{ shortcode: node.data.shortcode }}
              className="inline-flex min-h-11 items-center px-2 text-xs text-primary hover:underline sm:min-h-0"
            >
              {node.data.name} ({node.data.totalCount})
            </Link>
          ))}
        </nav>
      )}

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
        <LocationIcon type={node.data.type} product={null} size={14} />
        <Link
          to="/locations/$shortcode"
          params={{ shortcode: node.data.id }}
          className="hover:underline"
          style={{ pointerEvents: "auto" }}
        >
          {node.data.name}
        </Link>
      </div>
      <div className="mt-1 space-y-1 text-muted-foreground">
        <LocationTypeLabel type={node.data.type} product={null} />
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
