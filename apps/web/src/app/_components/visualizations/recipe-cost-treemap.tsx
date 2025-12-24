"use client";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import * as d3Hierarchy from "d3-hierarchy";
import Link from "next/link";
import { type IngredientDataItem } from "~/app/_components/units/univ-conversion";

interface CostNode {
  name: string;
  id: string | null;
  value: number; // Cost in dollars
  percentage: number;
  hasPrice: boolean;
}

interface TreemapNode {
  name: string;
  value: number;
  children?: CostNode[];
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

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

      const priceResult = ing.priceInfo?.price;
      if (priceResult?.success && priceResult.value.value > 0) {
        const cost = priceResult.value.value;
        pricedItems.push({
          name,
          id,
          value: cost,
          percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
          hasPrice: true,
        });
      } else {
        unpricedItems.push({
          name,
          id,
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
      <div className="text-muted-foreground flex h-[300px] items-center justify-center rounded-md border">
        <div className="text-center">
          <p>No cost data available</p>
          <p className="mt-1 text-sm">
            Add pricing to ingredients to see cost breakdown
          </p>
        </div>
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
  const [dimensions, setDimensions] = useState({ width: 400, height: 300 });
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDimensions({ width, height: Math.max(height, 250) });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height: Math.max(height, 250) });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

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

  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<CostNode>) => {
      if (!node.data.hasPrice) {
        return "hsl(220, 10%, 85%)"; // Gray for unpriced
      }
      // Green gradient based on percentage
      const lightness = Math.max(35, 65 - node.data.percentage * 0.5);
      return `hsl(142, 55%, ${lightness}%)`;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[300px] w-full overflow-hidden rounded-md border"
    >
      <svg width={dimensions.width} height={dimensions.height}>
        {nodes.map((node, i) => {
          const width = node.x1 - node.x0;
          const height = node.y1 - node.y0;
          const isHovered = hoveredNode === node.data.name;

          if (width < 4 || height < 4) return null;

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
                rx={3}
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
                      className={`text-xs font-medium ${
                        node.data.hasPrice ? "text-white" : "text-slate-600"
                      }`}
                      style={{
                        textShadow: node.data.hasPrice
                          ? "0 1px 2px rgba(0,0,0,0.3)"
                          : "none",
                      }}
                    >
                      {node.data.id ? (
                        <Link
                          href={`/ingredients/${node.data.id}`}
                          className="hover:underline"
                          style={{ pointerEvents: "auto" }}
                        >
                          {node.data.name.length > 20
                            ? node.data.name.slice(0, 18) + "..."
                            : node.data.name}
                        </Link>
                      ) : (
                        <span>
                          {node.data.name.length > 20
                            ? node.data.name.slice(0, 18) + "..."
                            : node.data.name}
                        </span>
                      )}
                    </div>
                    {node.data.hasPrice && width > 60 && height > 45 && (
                      <div
                        className="mt-0.5 text-[10px] text-white/80"
                        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}
                      >
                        {currency.format(node.data.value)} (
                        {node.data.percentage.toFixed(0)}%)
                      </div>
                    )}
                    {!node.data.hasPrice && width > 60 && height > 45 && (
                      <div className="mt-0.5 text-[10px] text-slate-500">
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
    <div className="bg-popover pointer-events-none absolute top-4 left-4 z-50 rounded-md px-3 py-2 text-sm shadow-lg">
      <div className="font-medium">{node.data.name}</div>
      <div className="text-muted-foreground mt-1">
        {node.data.hasPrice ? (
          <>
            <div>Cost: {currency.format(node.data.value)}</div>
            <div>{node.data.percentage.toFixed(1)}% of total</div>
          </>
        ) : (
          <div>No pricing data</div>
        )}
      </div>
    </div>
  );
}
