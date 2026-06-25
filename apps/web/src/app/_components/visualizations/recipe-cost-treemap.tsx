import { Link } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import type { IngredientDataItem } from "~/lib/recipe-costing";
import { formatCurrency } from "~/lib/utils";
import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizTooltip } from "./viz-overlay";

interface CostNode {
  name: string;
  id: string | null;
  // Unique identity per rendered cell: the recipeSectionIngredient row id.
  // `id` above is the ingredient id, which is NOT unique here — the same
  // ingredient can legitimately appear in multiple sections (or twice in one),
  // so keying cells by it produced React "duplicate key" warnings. `id` is kept
  // for the ingredient link; `rowKey` is the stable per-row React key.
  rowKey: string;
  value: number; // Cost in dollars
  percentage: number;
  hasPrice: boolean;
}

interface TreemapNode {
  name: string;
  value: number;
  children?: CostNode[];
}

interface RecipeCostTreemapProps {
  ingredients: IngredientDataItem[];
  totalCost: number;
}

export default function RecipeCostTreemap({
  ingredients,
  totalCost,
}: RecipeCostTreemapProps) {
  // Transform ingredient data into treemap structure
  const treemapData = useMemo(() => {
    const pricedItems: CostNode[] = [];
    const unpricedItems: CostNode[] = [];

    for (const ing of ingredients) {
      const name =
        ing.type === "ingredient"
          ? ing.ingredient.name
          : ing.type === "recipe"
            ? ing.recipe.name
            : "Unknown";

      const id = ing.type === "ingredient" ? ing.ingredient.id : null;
      // ing.id is the recipeSectionIngredient row id — unique per rendered cell.
      const rowKey = ing.id;

      const priceResult = ing.priceInfo?.price;
      if (priceResult?.isOk() && priceResult.value.value > 0) {
        const cost = priceResult.value.value;
        pricedItems.push({
          name,
          id,
          rowKey,
          value: cost,
          percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
          hasPrice: true,
        });
      } else {
        unpricedItems.push({
          name,
          id,
          rowKey,
          value: 1, // Placeholder value for layout
          percentage: 0,
          hasPrice: false,
        });
      }
    }

    // Sort by cost descending
    pricedItems.sort((a, b) => b.value - a.value);

    return {
      name: "Recipe Cost",
      value: totalCost,
      children: [...pricedItems, ...unpricedItems],
    };
  }, [ingredients, totalCost]);

  if (
    treemapData.children?.length === 0 ||
    treemapData.children?.every((c) => !c.hasPrice)
  ) {
    return (
      <VisualizationPlaceholder
        message="No cost data available"
        subMessage="Add pricing to ingredients to see cost breakdown"
        height={300}
      />
    );
  }

  return <Treemap data={treemapData} />;
}

interface TreemapProps {
  data: TreemapNode;
}

function Treemap({ data }: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 250,
    initialWidth: 400,
    initialHeight: 300,
  });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const noPricePatternId = useId();

  const hierarchy = useMemo(() => {
    return d3Hierarchy
      .hierarchy(data)
      .sum((d) => {
        // For leaf nodes, use their value
        if (!("children" in d) || !d.children) {
          return (d as CostNode).value;
        }
        return 0;
      })
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }, [data]);

  const treemapLayout = useMemo(() => {
    return d3Hierarchy
      .treemap<TreemapNode | CostNode>()
      .size([dimensions.width, dimensions.height])
      .paddingOuter(4)
      .paddingInner(2)
      .round(true)(hierarchy);
  }, [hierarchy, dimensions]);

  const nodes = useMemo(
    () =>
      treemapLayout.leaves() as d3Hierarchy.HierarchyRectangularNode<CostNode>[],
    [treemapLayout],
  );

  // Sequential ink ramp (paper -> ultramarine): bigger cost share -> deeper
  // step. Unpriced cells get a hatched pattern instead of a dominant gray.
  const getNodeFill = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<CostNode>) => {
      if (!node.data.hasPrice) return `url(#${noPricePatternId})`;
      const p = node.data.percentage;
      if (p >= 40) return "var(--chart-seq-5)";
      if (p >= 25) return "var(--chart-seq-4)";
      if (p >= 12) return "var(--chart-seq-3)";
      if (p >= 5) return "var(--chart-seq-2)";
      return "var(--chart-seq-1)";
    },
    [noPricePatternId],
  );
  // Deep ramp steps need paper-colored ink; shallow steps read with foreground.
  const isDeepFill = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<CostNode>) =>
      node.data.hasPrice && node.data.percentage >= 25,
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[300px] w-full overflow-hidden rounded-md border border-[var(--border-chunky)]"
    >
      <svg
        aria-hidden="true"
        width={dimensions.width}
        height={dimensions.height}
      >
        <defs>
          <pattern
            id={noPricePatternId}
            width="8"
            height="8"
            patternTransform="rotate(45)"
            patternUnits="userSpaceOnUse"
          >
            <rect width="8" height="8" fill="var(--muted)" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="8"
              stroke="var(--background)"
              strokeWidth="4"
            />
          </pattern>
        </defs>
        {nodes.map((node) => {
          const width = node.x1 - node.x0;
          const height = node.y1 - node.y0;
          const isHovered = hoveredNode === node.data.name;

          if (width < 4 || height < 4) return null;

          return (
            <g key={node.data.rowKey}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: D3 treemap visualization hover interaction */}
              <rect
                x={node.x0}
                y={node.y0}
                width={width}
                height={height}
                fill={getNodeFill(node)}
                stroke={isHovered ? "var(--primary)" : "var(--border-chunky)"}
                strokeWidth={isHovered ? 2.5 : 1.5}
                strokeDasharray={node.data.hasPrice ? undefined : "4 3"}
                rx={0}
                className="cursor-pointer transition-opacity hover:opacity-90"
                onMouseEnter={() => setHoveredNode(node.data.name)}
                onMouseLeave={() => setHoveredNode(null)}
              />
              {width > 50 && height > 30 && (
                <foreignObject
                  x={node.x0 + 4}
                  y={node.y0 + 4}
                  width={width - 8}
                  height={height - 8}
                  style={{ pointerEvents: "none" }}
                >
                  <div className="flex h-full flex-col overflow-hidden">
                    <div
                      className="font-medium text-xs"
                      style={{
                        color: isDeepFill(node)
                          ? "var(--background)"
                          : node.data.hasPrice
                            ? "var(--foreground)"
                            : "var(--muted-foreground)",
                      }}
                    >
                      {node.data.id ? (
                        <Link
                          to="/ingredients/$id"
                          params={{ id: node.data.id }}
                          className="hover:underline"
                          style={{ pointerEvents: "auto" }}
                        >
                          {node.data.name.length > 20
                            ? `${node.data.name.slice(0, 18)}...`
                            : node.data.name}
                        </Link>
                      ) : (
                        <span>
                          {node.data.name.length > 20
                            ? `${node.data.name.slice(0, 18)}...`
                            : node.data.name}
                        </span>
                      )}
                    </div>
                    {node.data.hasPrice && width > 60 && height > 45 && (
                      <div
                        className={
                          "mt-0.5 font-mono text-2xs tabular-nums" /* tight: label stack inside a clipped treemap tile */
                        }
                        style={{
                          color: isDeepFill(node)
                            ? "oklch(from var(--background) l c h / 0.85)"
                            : "var(--muted-foreground)",
                        }}
                      >
                        {formatCurrency(node.data.value)} (
                        {node.data.percentage.toFixed(0)}%)
                      </div>
                    )}
                    {!node.data.hasPrice && width > 60 && height > 45 && (
                      <div
                        className={
                          "mt-0.5 font-mono text-2xs text-muted-foreground uppercase" /* tight: label stack inside a clipped treemap tile */
                        }
                      >
                        No price
                      </div>
                    )}
                  </div>
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>

      {hoveredNode && <HoverTooltip nodes={nodes} hoveredName={hoveredNode} />}
    </div>
  );
}

function HoverTooltip({
  nodes,
  hoveredName,
}: {
  nodes: d3Hierarchy.HierarchyRectangularNode<CostNode>[];
  hoveredName: string;
}) {
  const node = nodes.find((n) => n.data.name === hoveredName);
  if (!node) return null;

  return (
    <VizTooltip>
      <div className="font-medium">{node.data.name}</div>
      <div className="mt-1 text-muted-foreground">
        {node.data.hasPrice ? (
          <>
            <div>Cost: {formatCurrency(node.data.value)}</div>
            <div>{node.data.percentage.toFixed(1)}% of total</div>
          </>
        ) : (
          <div>No pricing data</div>
        )}
      </div>
    </VizTooltip>
  );
}
