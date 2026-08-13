import type { ProductCategory } from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { sumBy } from "es-toolkit";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  formatCategoryLabel,
  getCategoryColor,
} from "~/app/_components/products/category-theme";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { useTRPC } from "~/integrations/trpc/react";
import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizTooltip } from "./viz-overlay";

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

// getCategoryColor reserves --chart-1 (Live Ultramarine) for "food" — but food
// is almost always the majority slice here, so painting the dominant wedge in
// the interaction accent breaks the One Loud Thing rule (DESIGN.md: ultramarine
// marks an action/focus/one live value, not decorates a whole panel). Route it
// to the darkest ink tone instead; every other category keeps the shared ramp.
function sliceFillColor(category: ProductCategory | null): string {
  return category === "food" ? "var(--chart-2)" : getCategoryColor(category);
}

// Which slice fills need light-on-dark labels vs dark-on-light labels, sized
// against the actual WCAG contrast ratios for these tokens: chart-2/3/4 clear
// 4.5:1 only against white (chart-4 vs the paper token lands at 4.42:1, just
// under), while chart-5 and up clear 4.5:1 against ink. Not a lightness
// threshold you can compute from the CSS custom property at render time —
// derived once against the known oklch values in styles.css.
const DARK_SLICE_FILLS = new Set([
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
]);

function sliceLabelColor(fill: string): string {
  return DARK_SLICE_FILLS.has(fill)
    ? "var(--primary-foreground)"
    : "var(--foreground)";
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
    () => sumBy(data, (d) => d.productCount),
    [data],
  );

  // `data` arrives sorted desc by productCount (see getCategoryDistribution),
  // so the first entries are already the chart's leading values.
  const chartSummary = useMemo(() => {
    const top = data
      .slice(0, 3)
      .map(
        (d) =>
          `${formatCategoryLabel(d.category)} ${d.productCount.toLocaleString()}`,
      )
      .join("; ");
    const categoryWord = data.length === 1 ? "category" : "categories";
    return `Products by category: ${top}; ${data.length} ${categoryWord} total`;
  }, [data]);

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
      className="relative h-100 w-full overflow-hidden border border-[var(--border)]"
    >
      <svg
        role="img"
        aria-label={chartSummary}
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
            const fill = sliceFillColor(slice.category);
            const categoryLabel = formatCategoryLabel(slice.category);

            return (
              <g key={slice.category ?? "uncategorized"}>
                <Link
                  to="/products"
                  search={{ category: slice.category ?? "" }}
                  aria-label={`${categoryLabel}: ${slice.productCount.toLocaleString()} product${slice.productCount !== 1 ? "s" : ""}`}
                >
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: D3 donut chart hover interaction */}
                  <path
                    d={arc(
                      slice.startAngle,
                      slice.endAngle,
                      isHovered ? innerRadius - 4 : innerRadius,
                      isHovered ? outerRadius + 4 : outerRadius,
                    )}
                    fill={fill}
                    stroke={isHovered ? "var(--primary)" : "var(--background)"}
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
                    fill={sliceLabelColor(fill)}
                    className="pointer-events-none font-medium text-xs capitalize"
                  >
                    {categoryLabel}
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
    <VizTooltip>
      <div className="flex items-center gap-2 font-medium">
        <div
          className="size-3"
          style={{ backgroundColor: sliceFillColor(slice.category) }}
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
    </VizTooltip>
  );
}
