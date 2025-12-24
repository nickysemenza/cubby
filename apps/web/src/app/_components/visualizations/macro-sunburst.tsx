"use client";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import * as d3Hierarchy from "d3-hierarchy";
import Link from "next/link";
import { type IngredientDataItem } from "~/app/_components/units/univ-conversion";
import { TIER1_NUTRIENTS } from "@recipehub/usda-schemas";

// Define which macros to show and their display properties
type MacroKey = "kcal" | "protein" | "fat" | "carbs";

const MACRO_DISPLAY: Record<
  MacroKey,
  { color: { h: number; s: number; l: number }; label: string }
> = {
  kcal: { color: { h: 30, s: 70, l: 50 }, label: "Calories" }, // Orange
  protein: { color: { h: 350, s: 65, l: 50 }, label: "Protein" }, // Red/Pink
  fat: { color: { h: 45, s: 80, l: 55 }, label: "Fat" }, // Yellow
  carbs: { color: { h: 200, s: 60, l: 50 }, label: "Carbs" }, // Blue/Teal
} as const;

// Get the nutrient code for a macro key using the centralized definition
const getMacroCode = (key: MacroKey): string => TIER1_NUTRIENTS[key].code;
const getMacroUnit = (key: MacroKey): string =>
  TIER1_NUTRIENTS[key].unit.toLowerCase();

interface MacroNode {
  name: string;
  macro?: MacroKey;
  ingredientId?: string;
  value: number;
  unit: string;
  children?: MacroNode[];
}

interface MacroSunburstProps {
  ingredients: IngredientDataItem[];
}

export default function MacroSunburst({ ingredients }: MacroSunburstProps) {
  // Build hierarchical data: Root -> Macros -> Ingredients
  const sunburstData = useMemo(() => {
    const macroKeys: MacroKey[] = ["kcal", "protein", "fat", "carbs"];
    const macros: Record<
      MacroKey,
      { total: number; ingredients: MacroNode[] }
    > = {
      kcal: { total: 0, ingredients: [] },
      protein: { total: 0, ingredients: [] },
      fat: { total: 0, ingredients: [] },
      carbs: { total: 0, ingredients: [] },
    };

    for (const ing of ingredients) {
      const nutrientResult = ing.priceInfo?.nutrient;
      if (!nutrientResult?.success) continue;

      const nutrients = nutrientResult.value;
      const name =
        ing.type === "ingredient"
          ? ing.ingredient.name
          : ing.type === "recipe"
            ? ing.recipe.name
            : "Unknown";
      const id = ing.type === "ingredient" ? ing.ingredient.id : undefined;

      // Extract macro values using centralized nutrient codes
      for (const macroKey of macroKeys) {
        const code = getMacroCode(macroKey);
        const value = nutrients[code];
        if (value && value > 0) {
          macros[macroKey].total += value;
          macros[macroKey].ingredients.push({
            name,
            ingredientId: id,
            value,
            unit: getMacroUnit(macroKey),
          });
        }
      }
    }

    // Build hierarchy
    const children: MacroNode[] = [];

    for (const macroKey of macroKeys) {
      const data = macros[macroKey];
      if (data.total > 0) {
        // Sort ingredients by value descending
        data.ingredients.sort((a, b) => b.value - a.value);

        children.push({
          name: MACRO_DISPLAY[macroKey].label,
          macro: macroKey,
          value: data.total,
          unit: getMacroUnit(macroKey),
          children: data.ingredients,
        });
      }
    }

    return {
      name: "Nutrition",
      value: 0,
      unit: "",
      children,
    };
  }, [ingredients]);

  const hasData = sunburstData.children && sunburstData.children.length > 0;

  if (!hasData) {
    return (
      <div className="text-muted-foreground flex h-[300px] items-center justify-center rounded-md border">
        <div className="text-center">
          <p>No nutrition data available</p>
          <p className="mt-1 text-sm">
            Link ingredients to USDA foods to see nutrition breakdown
          </p>
        </div>
      </div>
    );
  }

  return <Sunburst data={sunburstData} />;
}

interface SunburstProps {
  data: MacroNode;
}

function Sunburst({ data }: SunburstProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 400, height: 300 });
  const [hoveredNode, setHoveredNode] =
    useState<d3Hierarchy.HierarchyRectangularNode<MacroNode> | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      const size = Math.min(width, Math.max(height, 300));
      setDimensions({ width, height: size });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const size = Math.min(width, Math.max(height, 300));
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
    return d3Hierarchy.partition<MacroNode>().size([2 * Math.PI, radius])(
      hierarchy,
    );
  }, [hierarchy, radius]);

  const nodes = useMemo(
    () => partitionLayout.descendants().filter((d) => d.depth > 0),
    [partitionLayout],
  );

  const arc = useCallback(
    (d: d3Hierarchy.HierarchyRectangularNode<MacroNode>) => {
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

  const getNodeColor = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<MacroNode>) => {
      // Get the macro type (either from this node or parent)
      const macroKey = node.data.macro ?? node.parent?.data.macro;
      if (!macroKey) return "hsl(220, 10%, 70%)";

      const color = MACRO_DISPLAY[macroKey].color;
      // Outer ring (ingredients) is lighter
      const lightnessAdjust = node.depth === 2 ? 15 : 0;
      return `hsl(${color.h}, ${color.s}%, ${color.l + lightnessAdjust}%)`;
    },
    [],
  );

  const shouldShowLabel = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<MacroNode>) => {
      const arcLength = (node.x1 - node.x0) * ((node.y0 + node.y1) / 2);
      return arcLength > 30;
    },
    [],
  );

  const getLabelPosition = useCallback(
    (node: d3Hierarchy.HierarchyRectangularNode<MacroNode>) => {
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

  // Get center text based on hover
  const centerText = useMemo(() => {
    if (hoveredNode) {
      const isIngredient = hoveredNode.depth === 2;
      return {
        primary: hoveredNode.data.name,
        secondary: `${hoveredNode.data.value.toFixed(isIngredient ? 1 : 0)} ${hoveredNode.data.unit}`,
      };
    }
    // Show total calories by default
    const caloriesNode = nodes.find((n) => n.data.macro === "kcal");
    if (caloriesNode) {
      return {
        primary: "Total",
        secondary: `${caloriesNode.data.value.toFixed(0)} kcal`,
      };
    }
    return { primary: "", secondary: "" };
  }, [hoveredNode, nodes]);

  // Get macro totals for the legend
  const macroTotals = useMemo(() => {
    const totals: Record<MacroKey, number> = {
      kcal: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
    };
    for (const node of nodes) {
      if (node.depth === 1 && node.data.macro) {
        totals[node.data.macro] = node.data.value;
      }
    }
    return totals;
  }, [nodes]);

  return (
    <div
      ref={containerRef}
      className="relative h-[300px] w-full overflow-hidden rounded-md border"
    >
      <svg width={dimensions.width} height={dimensions.height}>
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {nodes.map((node, i) => {
            const isHovered =
              hoveredNode?.data.name === node.data.name &&
              hoveredNode?.depth === node.depth;
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
                {shouldShowLabel(node) && node.depth === 1 && (
                  <text
                    x={labelPos.x}
                    y={labelPos.y}
                    transform={`rotate(${labelPos.rotation}, ${labelPos.x}, ${labelPos.y})`}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none fill-white text-[10px] font-medium"
                    style={{ textShadow: "0 1px 2px rgba(0,0,0,0.4)" }}
                  >
                    {node.data.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* Center circle with summary */}
          <circle r={radius * 0.25} fill="hsl(var(--background))" />
          <text
            textAnchor="middle"
            y={-6}
            className="fill-foreground text-xs font-medium"
          >
            {centerText.primary}
          </text>
          <text
            textAnchor="middle"
            y={10}
            className="fill-muted-foreground text-[10px]"
          >
            {centerText.secondary}
          </text>
        </g>
      </svg>

      {/* Tooltip */}
      {hoveredNode && hoveredNode.depth === 2 && (
        <div className="bg-popover pointer-events-none absolute top-4 left-4 z-50 rounded-md px-3 py-2 text-sm shadow-lg">
          <div className="font-medium">
            {hoveredNode.data.ingredientId ? (
              <Link
                href={`/ingredients/${hoveredNode.data.ingredientId}`}
                className="hover:underline"
                style={{ pointerEvents: "auto" }}
              >
                {hoveredNode.data.name}
              </Link>
            ) : (
              hoveredNode.data.name
            )}
          </div>
          <div className="text-muted-foreground mt-1">
            {hoveredNode.data.value.toFixed(1)} {hoveredNode.data.unit}{" "}
            {hoveredNode.parent?.data.name.toLowerCase()}
          </div>
        </div>
      )}

      {/* Legend with totals */}
      <div className="bg-background/80 absolute right-2 bottom-2 flex gap-4 rounded px-2 py-1.5 text-[10px] backdrop-blur">
        {(Object.keys(MACRO_DISPLAY) as MacroKey[]).map((macro) => (
          <div key={macro} className="flex items-center gap-1.5">
            <div
              className="h-2.5 w-2.5 rounded-full"
              style={{
                backgroundColor: `hsl(${MACRO_DISPLAY[macro].color.h}, ${MACRO_DISPLAY[macro].color.s}%, ${MACRO_DISPLAY[macro].color.l}%)`,
              }}
            />
            <div className="flex flex-col leading-tight">
              <span className="text-foreground font-medium">
                {macroTotals[macro] > 0
                  ? `${macroTotals[macro].toFixed(0)}${getMacroUnit(macro)}`
                  : "-"}
              </span>
              <span className="text-muted-foreground text-[9px]">
                {MACRO_DISPLAY[macro].label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
