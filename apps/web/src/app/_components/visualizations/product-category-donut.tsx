import type { ProductCategory } from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  formatCategoryLabel,
  getCategoryColor,
} from "~/app/_components/products/category-theme";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { useTRPC } from "~/trpc/react";
import { VisualizationPlaceholder } from "./visualization-placeholder";

type CategoryData = {
  category: ProductCategory | null;
  productCount: number;
  locations: Array<{ id: string; name: string; count: number }>;
};

export default function ProductCategoryDonut() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.product.categoryDistribution.queryOptions(),
  );

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading category data..."
        height={400}
      />
    );
  }

  if (!data || data.length === 0) {
    return (
      <VisualizationPlaceholder message="No products to display" height={400} />
    );
  }

  return <DonutChart data={data} />;
}

interface DonutChartProps {
  data: CategoryData[];
}

function DonutChart({ data }: DonutChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 350,
    initialWidth: 400,
    initialHeight: 400,
  });
  const [hoveredSlice, setHoveredSlice] = useState<CategoryData | null>(null);

  const totalProducts = useMemo(
    () => data.reduce((sum, d) => sum + d.productCount, 0),
    [data],
  );

  const radius = Math.min(dimensions.width, dimensions.height) / 2;
  const innerRadius = radius * 0.55;
  const outerRadius = radius * 0.85;

  // Calculate slice angles
  const slices = useMemo(() => {
    let currentAngle = -Math.PI / 2; // Start at top
    return data.map((d) => {
      const angle = (d.productCount / totalProducts) * 2 * Math.PI;
      const slice = {
        ...d,
        startAngle: currentAngle,
        endAngle: currentAngle + angle,
      };
      currentAngle += angle;
      return slice;
    });
  }, [data, totalProducts]);

  // Generate arc path
  const arc = useCallback(
    (startAngle: number, endAngle: number, inner: number, outer: number) => {
      const x0 = Math.cos(startAngle);
      const y0 = Math.sin(startAngle);
      const x1 = Math.cos(endAngle);
      const y1 = Math.sin(endAngle);

      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

      return `
        M ${inner * x0} ${inner * y0}
        A ${inner} ${inner} 0 ${largeArc} 1 ${inner * x1} ${inner * y1}
        L ${outer * x1} ${outer * y1}
        A ${outer} ${outer} 0 ${largeArc} 0 ${outer * x0} ${outer * y0}
        Z
      `;
    },
    [],
  );

  // Get label position at the center of the arc
  const getLabelPosition = useCallback(
    (startAngle: number, endAngle: number) => {
      const midAngle = (startAngle + endAngle) / 2;
      const labelRadius = (innerRadius + outerRadius) / 2;
      return {
        x: Math.cos(midAngle) * labelRadius,
        y: Math.sin(midAngle) * labelRadius,
        rotation: (midAngle * 180) / Math.PI + 90,
      };
    },
    [innerRadius, outerRadius],
  );

  // Check if slice is large enough for a label
  const shouldShowLabel = useCallback(
    (startAngle: number, endAngle: number) => {
      const arcAngle = endAngle - startAngle;
      // Show label if slice is at least ~8% of the chart
      return arcAngle > 0.5;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-100 w-full overflow-hidden rounded-md border"
    >
      <svg
        aria-hidden="true"
        width={dimensions.width}
        height={dimensions.height}
      >
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {slices.map((slice) => {
            const isHovered = hoveredSlice?.category === slice.category;
            const labelPos = getLabelPosition(slice.startAngle, slice.endAngle);
            const showLabel = shouldShowLabel(slice.startAngle, slice.endAngle);

            return (
              <g key={slice.category ?? "uncategorized"}>
                <Link
                  to="/products"
                  search={{ category: slice.category ?? "" }}
                >
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: D3 donut chart hover interaction */}
                  <path
                    d={arc(
                      slice.startAngle,
                      slice.endAngle,
                      isHovered ? innerRadius - 4 : innerRadius,
                      isHovered ? outerRadius + 4 : outerRadius,
                    )}
                    fill={getCategoryColor(slice.category)}
                    stroke={isHovered ? "hsl(var(--primary))" : "white"}
                    strokeWidth={isHovered ? 2 : 1}
                    className="cursor-pointer transition-all duration-150"
                    onMouseEnter={() => setHoveredSlice(slice)}
                    onMouseLeave={() => setHoveredSlice(null)}
                  />
                </Link>
                {showLabel && (
                  <text
                    x={labelPos.x}
                    y={labelPos.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none fill-white font-medium text-xs capitalize"
                    style={{ textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}
                  >
                    {formatCategoryLabel(slice.category)}
                  </text>
                )}
              </g>
            );
          })}

          {/* Center text */}
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-foreground font-semibold text-lg"
            y={-8}
          >
            {hoveredSlice ? hoveredSlice.productCount : totalProducts}
          </text>
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-muted-foreground text-xs"
            y={12}
          >
            {hoveredSlice
              ? formatCategoryLabel(hoveredSlice.category)
              : "products"}
          </text>
        </g>
      </svg>

      {hoveredSlice && <HoverTooltip slice={hoveredSlice} />}
    </div>
  );
}

function HoverTooltip({ slice }: { slice: CategoryData }) {
  return (
    <div className="pointer-events-none absolute top-4 left-4 z-50 rounded-md bg-popover px-3 py-2 text-sm shadow-lg">
      <div className="flex items-center gap-2 font-medium">
        <div
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: getCategoryColor(slice.category) }}
        />
        <span className="capitalize">
          {formatCategoryLabel(slice.category)}
        </span>
      </div>
      <div className="mt-1 text-muted-foreground">
        {slice.productCount} product{slice.productCount !== 1 ? "s" : ""}
      </div>
      {slice.locations.length > 0 && (
        <div className="mt-2 border-t pt-2">
          <div className="mb-1 font-medium text-xs">Top locations:</div>
          {slice.locations.map((loc) => (
            <div key={loc.id} className="text-muted-foreground text-xs">
              {loc.name} ({loc.count})
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 border-t pt-2 text-muted-foreground text-xs">
        Click to view products →
      </div>
    </div>
  );
}
