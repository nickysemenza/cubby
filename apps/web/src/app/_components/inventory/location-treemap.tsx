import { Link } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { Row, Stack } from "~/components/layout";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import {
  type LocationHierarchyNode,
  useLocationHierarchy,
} from "~/hooks/useLocationHierarchy";
import { formatCurrency } from "~/lib/utils";
import { formatPricingStatusSummary } from "../locations/calculate-inventory-valuation";
import { LocationIcon } from "../locations/location-icons";
import { VisualizationPlaceholder } from "../visualizations/visualization-placeholder";

export default function LocationTreemap() {
  const { data, isLoading } = useLocationHierarchy({
    valuationMode: "equalWeight",
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

  return <Treemap data={data} />;
}

interface TreemapProps {
  data: LocationHierarchyNode;
}

function Treemap({ data }: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 400,
    initialWidth: 800,
    initialHeight: 500,
  });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const hierarchy = useMemo(() => {
    return d3Hierarchy
      .hierarchy(data)
      .sum((d) => (d.children ? 0 : d.value))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }, [data]);

  const treemapLayout = useMemo(() => {
    return d3Hierarchy
      .treemap<LocationHierarchyNode>()
      .size([dimensions.width, dimensions.height])
      .paddingOuter(4)
      .paddingTop(24)
      .paddingInner(2)
      .round(true)(hierarchy);
  }, [hierarchy, dimensions]);

  const nodes = useMemo(() => treemapLayout.descendants(), [treemapLayout]);

  // Sequential ink ladder (paper -> ultramarine) by depth: the root ring burns
  // deepest and each nested level steps lighter toward paper. Empty cells drop
  // out to the lightest step so they read as "unfilled".
  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) => {
      if (node.data.totalCount === 0) return "var(--chart-seq-1)";
      const ramp = [
        "var(--chart-seq-5)",
        "var(--chart-seq-4)",
        "var(--chart-seq-3)",
        "var(--chart-seq-2)",
        "var(--chart-seq-1)",
      ];
      // depth 1 = top visible ring (root is skipped) -> deepest step.
      return ramp[Math.min(node.depth - 1, ramp.length - 1)] ?? ramp[0];
    },
    [],
  );

  // Deep ramp steps need paper-colored ink; lighter steps read with foreground.
  const isDeepCell = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>) =>
      node.data.totalCount > 0 && node.depth <= 2,
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
        {nodes.map((node) => {
          const width = node.x1 - node.x0;
          const height = node.y1 - node.y0;
          const isRoot = node.depth === 0;
          const isHovered = hoveredNode === node.data.id;

          if (isRoot) return null;
          if (width < 20 || height < 20) return null;

          return (
            <g key={node.data.id}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: D3 treemap visualization hover interaction */}
              <rect
                x={node.x0}
                y={node.y0}
                width={width}
                height={height}
                fill={getNodeColor(node)}
                stroke={isHovered ? "var(--primary)" : "var(--background)"}
                strokeWidth={isHovered ? 2 : 1}
                rx={0}
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
                          ? "text-muted-foreground"
                          : isDeepCell(node)
                            ? "text-background"
                            : "text-foreground"
                      }`}
                    >
                      <Link
                        to="/locations/$shortcode"
                        params={{ shortcode: node.data.id ?? "" }}
                        disabled={!node.data.id}
                        className="flex min-w-0 items-center gap-1 font-medium hover:underline"
                        style={{ pointerEvents: "auto" }}
                      >
                        <LocationIcon
                          type={node.data.type}
                          size={12}
                          className="shrink-0"
                        />
                        <span className="truncate" title={node.data.name}>
                          {node.data.name}
                        </span>
                      </Link>
                      {width > 160 && node.data.totalCount > 0 && (
                        <span className="shrink-0 text-2xs opacity-80">
                          · {node.data.totalCount}
                        </span>
                      )}
                      {width > 220 && node.data.totalValuation > 0 && (
                        <span className="shrink-0 text-2xs opacity-80">
                          · {formatCurrency(node.data.totalValuation, 0)}
                          {(node.data.totalPricingStatus.missingPricing.count >
                            0 ||
                            node.data.totalPricingStatus.miscNoPrice.count >
                              0) && (
                            <span className="opacity-60">
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
                        <span className="shrink-0 text-2xs text-muted-foreground">
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
  nodes: d3Hierarchy.HierarchyRectangularNode<LocationHierarchyNode>[];
  hoveredId: string;
}) {
  const node = nodes.find((n) => n.data.id === hoveredId);
  if (!node) return null;

  const x = Math.min(node.x0 + 10, window.innerWidth - 200);
  const y = node.y0 + 30;

  return (
    <ChartTooltip
      className="pointer-events-none absolute z-50 px-2"
      style={{ left: x, top: y }}
    >
      <Row align="center" gap="sm" className="font-medium">
        <LocationIcon type={node.data.type} size={14} />
        {node.data.name}
      </Row>
      <Stack gap="xs" className="mt-1 text-muted-foreground">
        <div>Type: {node.data.type}</div>
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
      </Stack>
    </ChartTooltip>
  );
}
