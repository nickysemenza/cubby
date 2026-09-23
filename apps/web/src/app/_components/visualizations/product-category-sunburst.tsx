import { Link, useNavigate } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import { useId, useMemo, useRef, useState } from "react";

import {
  CATEGORY_HIERARCHY_ROOT_ID,
  type CategoryHierarchyNode,
} from "~/app/product-categories/category-tree";
import {
  categoryNodeColor,
  useCategoryHierarchy,
} from "~/app/product-categories/use-category-hierarchy";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { getAppErrorDetails } from "~/lib/error-utils";

import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizTooltip } from "./viz-overlay";

type ArcNode = d3Hierarchy.HierarchyRectangularNode<CategoryHierarchyNode>;

/** Deeper rings fade so the same feature color reads as one family. */
const RING_OPACITY = [1, 1, 0.75, 0.55];

export default function ProductCategorySunburst() {
  const { data, isLoading, isError, error, refetch } = useCategoryHierarchy();

  if (isLoading) {
    return (
      <VisualizationPlaceholder message="Loading categories..." height={500} />
    );
  }
  if (isError) {
    return (
      <VisualizationPlaceholder
        message="Product categories are unavailable"
        subMessage={getAppErrorDetails(error).message}
        height={500}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data || data.totalCount === 0) {
    return (
      <VisualizationPlaceholder
        message="No categorized products to display"
        height={500}
      />
    );
  }
  return <Sunburst data={data} />;
}

function arcPath(node: ArcNode) {
  const { x0: start, x1: end, y0: inner, y1: outer } = node;
  const sx = Math.cos(start - Math.PI / 2);
  const sy = Math.sin(start - Math.PI / 2);
  const ex = Math.cos(end - Math.PI / 2);
  const ey = Math.sin(end - Math.PI / 2);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${inner * sx} ${inner * sy}
    A ${inner} ${inner} 0 ${largeArc} 1 ${inner * ex} ${inner * ey}
    L ${outer * ex} ${outer * ey}
    A ${outer} ${outer} 0 ${largeArc} 0 ${outer * sx} ${outer * sy} Z`;
}

function labelPlacement(node: ArcNode) {
  const angle = (node.x0 + node.x1) / 2;
  const r = (node.y0 + node.y1) / 2;
  const x = Math.cos(angle - Math.PI / 2) * r;
  const y = Math.sin(angle - Math.PI / 2) * r;
  const rotation = ((angle * 180) / Math.PI - 90) % 360;
  const flip = rotation > 90 && rotation < 270;
  const fits = (node.x1 - node.x0) * r > 40 && node.y1 - node.y0 > 20;
  return { x, y, rotation: flip ? rotation + 180 : rotation, fits };
}

function Sunburst({ data }: { data: CategoryHierarchyNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const navigate = useNavigate();
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 400,
    initialWidth: 500,
    initialHeight: 500,
  });
  const [hovered, setHovered] = useState<ArcNode | null>(null);
  const radius = Math.min(dimensions.width, dimensions.height) / 2;

  const nodes = useMemo(() => {
    // `sum` adds each node's own value to its descendants', so products
    // assigned directly to a group still count toward that group's arc.
    const hierarchy = d3Hierarchy
      .hierarchy(data)
      .sum((node) => node.directCount)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return d3Hierarchy
      .partition<CategoryHierarchyNode>()
      .size([2 * Math.PI, radius])(hierarchy)
      .descendants()
      .filter(
        (node) => node.depth > 0 && node.x1 - node.x0 > 0.002 && node.value,
      );
  }, [data, radius]);

  const topRoots = useMemo(
    () => nodes.filter((node) => node.depth === 1).slice(0, 4),
    [nodes],
  );
  const summary = `Products by category: ${topRoots
    .map((node) => `${node.data.name} ${node.data.totalCount}`)
    .join("; ")}; ${data.totalCount} categorized products total`;

  return (
    <div
      ref={containerRef}
      className="relative h-[500px] w-full overflow-hidden border border-[var(--border)]"
    >
      <svg
        aria-label={summary}
        aria-describedby={summaryId}
        width={dimensions.width}
        height={dimensions.height}
      >
        <title>{summary}</title>
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {nodes.map((node) => {
            const isHovered = hovered?.data.id === node.data.id;
            const label = labelPlacement(node);
            return (
              <g key={node.data.id}>
                <path
                  d={arcPath(node)}
                  fill={categoryNodeColor(node.data)}
                  fillOpacity={RING_OPACITY[node.depth] ?? 0.5}
                  stroke={isHovered ? "var(--primary)" : "var(--background)"}
                  strokeWidth={isHovered ? 2 : 1}
                  className="cursor-pointer"
                  onMouseEnter={() => setHovered(node)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() =>
                    void navigate({
                      to: "/product-categories/$shortcode",
                      params: { shortcode: node.data.id },
                    })
                  }
                />
                {label.fits && (
                  <text
                    x={label.x}
                    y={label.y}
                    transform={`rotate(${label.rotation}, ${label.x}, ${label.y})`}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none text-2xs font-medium"
                    fill="var(--foreground)"
                    stroke="var(--background)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {node.data.name.length > 12
                      ? `${node.data.name.slice(0, 10)}…`
                      : node.data.name}
                  </text>
                )}
              </g>
            );
          })}
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-foreground text-sm font-medium"
          >
            {hovered ? hovered.data.name : `${data.totalCount} products`}
          </text>
          {hovered && (
            <text
              y={16}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted-foreground text-xs"
            >
              {hovered.data.totalCount} products
            </text>
          )}
        </g>
      </svg>

      <p id={summaryId} className="sr-only">
        {summary}. Use the category links below to open a category.
      </p>

      {topRoots.length > 0 && (
        <nav
          aria-label="Largest product categories"
          className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1 border border-[var(--border)] bg-background/95 p-1"
        >
          {topRoots.map((node) => (
            <Link
              key={node.data.id}
              to="/product-categories/$shortcode"
              params={{ shortcode: node.data.id }}
              className="inline-flex min-h-11 items-center px-2 text-xs text-primary hover:underline sm:min-h-0"
            >
              {node.data.name} ({node.data.totalCount})
            </Link>
          ))}
        </nav>
      )}

      {hovered && <ArcTooltip node={hovered} />}
    </div>
  );
}

function ArcTooltip({ node }: { node: ArcNode }) {
  const path = node
    .ancestors()
    .reverse()
    .filter((ancestor) => ancestor.data.id !== CATEGORY_HIERARCHY_ROOT_ID)
    .map((ancestor) => ancestor.data.name)
    .join(" / ");
  return (
    <VizTooltip>
      <div className="font-medium">{path}</div>
      <div className="mt-1 text-muted-foreground">
        Products: {node.data.directCount} direct / {node.data.totalCount} total
      </div>
    </VizTooltip>
  );
}
