import {
  type BarDatum,
  ResponsiveBar,
  type ResponsiveBarSvgProps,
} from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import { ResponsivePie } from "@nivo/pie";
import type { Icon } from "@phosphor-icons/react/lib";
import { sumBy } from "es-toolkit";
import type { ComponentProps, ReactNode } from "react";
import { useMemo } from "react";

import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
  nivoMotion,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

// Shared building blocks behind Porcelain Transit charts: a horizontal
// bar primitive, a "top-N by absolute value, signed color" bar breakdown, a
// center-labeled donut, and a currency line trend. Each call site keeps only
// its genuinely custom bits (data prep, tick/label/tooltip renderers);
// sort/slice/color/chrome live here once instead of per-chart.

// ── HorizontalBarChart ───────────────────────────────────────────────────────

type HorizontalBarChartProps<D extends BarDatum> = Omit<
  ResponsiveBarSvgProps<D>,
  "layout"
> &
  Partial<
    Record<"height" | "minHeight" | "rowHeight" | "heightPadding", number>
  >;

export function HorizontalBarChart<D extends BarDatum>({
  data,
  height,
  minHeight = 220,
  rowHeight = 32,
  heightPadding = 60,
  ...props
}: HorizontalBarChartProps<D>) {
  const chartHeight =
    height ?? Math.max(minHeight, data.length * rowHeight + heightPadding);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar data={data} layout="horizontal" {...props} />
    </div>
  );
}

// ── RankedBarBreakdown ───────────────────────────────────────────────────────

type AxisLeft<D extends BarDatum> = NonNullable<
  ResponsiveBarSvgProps<D>["axisLeft"]
>;

export interface RankedBarBreakdownProps<T extends BarDatum> {
  data: T[];
  /** Numeric field driving sort order, default color, and the value shown. */
  valueKey: keyof T & string;
  /** String field used as the tooltip identity and (unless `idKey` is given) `indexBy`. */
  labelKey: keyof T & string;
  /** `indexBy` field, when it must be a stable id distinct from `labelKey`. */
  idKey?: keyof T & string;
  /** Rows kept, ranked by `Math.abs(value)` desc, then reversed for nivo's bottom-up layout. */
  topN?: number;
  /** Fixed chart height for dense dashboards; otherwise height grows per row. */
  height?: number;
  minHeight?: number;
  /** Per-row chart height; count-based charts are intentionally denser. */
  rowHeight?: number;
  heightPadding?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  /** Bar color per row; defaults to `value < 0 ? negative : chart-1`. */
  color?: (row: T) => string;
  /** Draw the value as an inline SVG label at the bar's end. Off by default. */
  showValueLabel?: boolean;
  labelSkipWidth?: number;
  /** Formats the value for the axis, inline label, and default tooltip. Defaults to whole-dollar currency. */
  formatValue?: (value: number) => string;
  /** Inline bar-label formatter when its compact form differs from the tooltip. */
  formatLabel?: (value: number) => string;
  /** `axisBottom.format` override; the axis otherwise uses `nivoCurrencyAxis`. */
  axisBottomFormat?: (value: number) => string;
  /** Custom `axisLeft` tick (e.g. an icon + name glyph in place of plain text). */
  renderTick?: AxisLeft<T>["renderTick"];
  /** Tooltip identity content; defaults to the plain `labelKey` string. */
  renderLabel?: (row: T) => ReactNode;
  /** Full tooltip override, for rows whose copy isn't "label — formatted value". */
  tooltip?: (row: T) => ReactNode;
  onClick?: (row: T) => void;
  /** Screen-reader summary for a chart whose SVG labels are not enough context. */
  summary?: string;
  emptyIcon?: Icon;
  emptyTitle: string;
}

export function RankedBarBreakdown<T extends BarDatum>({
  data,
  valueKey,
  labelKey,
  idKey,
  topN = 12,
  height,
  minHeight = 240,
  rowHeight,
  heightPadding,
  margin = { top: 10, right: 40, bottom: 40, left: 160 },
  color,
  showValueLabel = false,
  labelSkipWidth = 40,
  formatValue = (v) => formatCurrency(v, 0),
  formatLabel,
  axisBottomFormat,
  renderTick,
  renderLabel,
  tooltip,
  onClick,
  summary,
  emptyIcon,
  emptyTitle,
}: RankedBarBreakdownProps<T>) {
  const rows = useMemo(
    () =>
      [...data]
        .sort(
          (a, b) =>
            Math.abs(Number(b[valueKey])) - Math.abs(Number(a[valueKey])),
        )
        .slice(0, topN)
        .reverse(),
    [data, valueKey, topN],
  );

  if (rows.length === 0) {
    return <ChartEmpty icon={emptyIcon} title={emptyTitle} />;
  }

  const colorFor =
    color ??
    ((row: T) =>
      Number(row[valueKey]) < 0 ? "var(--chart-negative)" : "var(--chart-1)");
  const indexBy = idKey ?? labelKey;

  const chart = (
    <HorizontalBarChart
      data={rows}
      height={height}
      minHeight={minHeight}
      rowHeight={rowHeight}
      heightPadding={heightPadding}
      keys={[valueKey]}
      indexBy={indexBy}
      margin={margin}
      padding={0.25}
      // SAFETY: Nivo invokes this callback with the same row objects supplied in `data`.
      colors={({ data: d }) => colorFor(d as T)}
      {...nivoBarChrome}
      axisBottom={
        axisBottomFormat
          ? { ...nivoCurrencyAxis, format: axisBottomFormat }
          : nivoCurrencyAxis
      }
      axisLeft={{ tickSize: 0, tickPadding: 8, renderTick }}
      enableLabel={showValueLabel}
      label={
        showValueLabel
          ? (d) =>
              d.value != null && Number(d.value) > 0
                ? (formatLabel ?? formatValue)(Number(d.value))
                : ""
          : undefined
      }
      labelSkipWidth={showValueLabel ? labelSkipWidth : undefined}
      labelTextColor={showValueLabel ? "var(--background)" : undefined}
      enableGridX
      enableGridY={false}
      // SAFETY: Nivo's bar datum is the original generic row from `data`.
      onClick={onClick ? (bar) => onClick(bar.data as T) : undefined}
      tooltip={({ data: d }) => {
        // SAFETY: Nivo's tooltip datum is the original generic row from `data`.
        const row = d as T;
        if (tooltip) return <>{tooltip(row)}</>;
        return (
          <ChartTooltip>
            <strong>
              {renderLabel ? renderLabel(row) : String(row[labelKey])}
            </strong>{" "}
            —{" "}
            <span style={{ color: colorFor(row) }}>
              {formatValue(Number(row[valueKey]))}
            </span>
          </ChartTooltip>
        );
      }}
      theme={nivoChartTheme}
    />
  );

  if (!summary) return chart;

  return (
    <figure aria-label={summary}>
      <figcaption className="sr-only">{summary}.</figcaption>
      {chart}
    </figure>
  );
}

// ── CategoryDonut ────────────────────────────────────────────────────────────

interface CategoryDonutDatum {
  id: string;
  label: string;
  value: number;
  color: string;
}

export interface CategoryDonutProps {
  data: CategoryDonutDatum[];
  height?: number;
  /** Center number when nothing is selected (usually a true net, which may
   * exceed the sum of the positive-only arcs — see each caller). */
  centerValue: number;
  centerLabel: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Extra content appended under the value/percentage line in the tooltip. */
  renderTooltipExtra?: (id: string) => ReactNode;
  emptyIcon: Icon;
  emptyTitle: string;
}

/** Positive-arcs / net-center donut: the ring can only draw positive slices,
 * so the center label carries the true net across every bucket including
 * negative ones (refunds/credits) — see each caller for its own caption. */
export function CategoryDonut({
  data,
  height = 300,
  centerValue,
  centerLabel,
  selectedId,
  onSelect,
  renderTooltipExtra,
  emptyIcon,
  emptyTitle,
}: CategoryDonutProps) {
  const total = useMemo(() => sumBy(data, (d) => d.value), [data]);

  if (data.length === 0) {
    return <ChartEmpty icon={emptyIcon} title={emptyTitle} />;
  }

  const selected =
    selectedId != null ? data.find((d) => d.id === selectedId) : undefined;
  const centerText = selected ? selected.label : centerLabel;
  const shownCenterValue = selected?.value ?? centerValue;

  return (
    <div
      style={{ height }}
      className={onSelect ? "[&_path]:cursor-pointer" : undefined}
    >
      <ResponsivePie
        {...nivoMotion}
        data={data}
        colors={(d) => d.data.color}
        onClick={onSelect ? (d) => onSelect(String(d.id)) : undefined}
        // Controlled while a slice is drilled in — the selected arc stays
        // popped out (activeOuterRadiusOffset). Uncontrolled hover otherwise.
        activeId={selected ? selected.id : undefined}
        margin={{ top: 30, right: 100, bottom: 30, left: 100 }}
        innerRadius={0.6}
        padAngle={1}
        cornerRadius={0}
        activeOuterRadiusOffset={6}
        arcLinkLabelsSkipAngle={10}
        arcLinkLabelsTextColor="var(--foreground)"
        arcLinkLabelsColor={{ from: "color" }}
        arcLinkLabel={(d) => `${d.label} ${formatCurrency(d.value, 0)}`}
        arcLabelsSkipAngle={20}
        arcLabel={(d) => `${Math.round((d.value / total) * 100)}%`}
        arcLabelsTextColor="var(--background)"
        enableArcLabels
        tooltip={({ datum }) => (
          <ChartTooltip>
            <span style={{ color: datum.color }}>{datum.label}</span>:{" "}
            <strong>{formatCurrency(datum.value, 0)}</strong> (
            {((datum.value / total) * 100).toFixed(1)}%)
            {renderTooltipExtra?.(String(datum.id))}
          </ChartTooltip>
        )}
        layers={[
          "arcs",
          "arcLabels",
          "arcLinkLabels",
          "legends",
          ({ centerX, centerY }) => (
            <text
              x={centerX}
              y={centerY}
              textAnchor="middle"
              dominantBaseline="central"
              style={{ fill: "var(--foreground)" }}
            >
              <tspan x={centerX} dy="-0.5em" className="text-xl font-bold">
                {formatCurrency(shownCenterValue, 0)}
              </tspan>
              <tspan
                x={centerX}
                dy="1.4em"
                className="text-xs"
                style={{ fill: "var(--muted-foreground)" }}
              >
                {centerText}
              </tspan>
            </text>
          ),
        ]}
      />
    </div>
  );
}

// ── SpendTrend ───────────────────────────────────────────────────────────────

type LineProps = ComponentProps<typeof ResponsiveLine>;

interface SpendTrendProps extends Pick<
  LineProps,
  | "data"
  | "margin"
  | "xScale"
  | "xFormat"
  | "yScale"
  | "axisBottom"
  | "colors"
  | "areaOpacity"
  | "legends"
  | "markers"
  | "pointColor"
  | "pointBorderColor"
> {
  /** Skip zero-value points in the per-series slice tooltip. */
  filterZeroValues?: boolean;
  seriesLabelClassName?: string;
}

/** Shared Nivo line defaults and currency slice-tooltip for spend trends. */
export function SpendTrend({
  filterZeroValues = false,
  seriesLabelClassName,
  ...props
}: SpendTrendProps) {
  return (
    <div className="h-[300px]">
      <ResponsiveLine
        {...nivoMotion}
        axisLeft={{ format: (value: number) => formatCurrency(value, 0) }}
        enableArea
        pointSize={5}
        pointColor="var(--card)"
        pointBorderWidth={2}
        pointBorderColor={{ from: "serieColor" }}
        useMesh
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <ChartTooltip>
            <div className="mb-1 font-medium">
              {slice.points[0]?.data.xFormatted}
            </div>
            {slice.points
              .filter((point) => !filterZeroValues || Number(point.data.y) > 0)
              .map((point) => (
                <div key={point.id} className="flex items-center gap-2">
                  <div
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: point.seriesColor }}
                  />
                  <span className={seriesLabelClassName}>{point.seriesId}</span>
                  <strong className="ml-auto">
                    {formatCurrency(Number(point.data.y), 0)}
                  </strong>
                </div>
              ))}
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
        {...props}
      />
    </div>
  );
}
