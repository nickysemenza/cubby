import {
  type BarDatum,
  ResponsiveBar,
  type ResponsiveBarSvgProps,
} from "@nivo/bar";

type HorizontalBarChartProps<D extends BarDatum> = Omit<
  ResponsiveBarSvgProps<D>,
  "layout"
> &
  Partial<Record<"minHeight" | "rowHeight" | "heightPadding", number>>;
export function HorizontalBarChart<D extends BarDatum>({
  data,
  minHeight = 220,
  rowHeight = 32,
  heightPadding = 60,
  ...props
}: HorizontalBarChartProps<D>) {
  const height = Math.max(minHeight, data.length * rowHeight + heightPadding);

  return (
    <div style={{ height }}>
      <ResponsiveBar data={data} layout="horizontal" {...props} />
    </div>
  );
}
