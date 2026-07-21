import { ResponsiveLine } from "@nivo/line";
import type { ComponentProps } from "react";
import { formatCurrency } from "~/lib/utils";
import { nivoChartTheme } from "../shared";
import { ChartTooltip } from "./ChartTooltip";

type LineProps = ComponentProps<typeof ResponsiveLine>;

interface CurrencyTrendProps
  extends Pick<
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
  filterZeroValues?: boolean;
  seriesLabelClassName?: string;
}

/** Shared Nivo line defaults and currency tooltip for project trends. */
export function CurrencyTrend({
  filterZeroValues = false,
  seriesLabelClassName,
  ...props
}: CurrencyTrendProps) {
  return (
    <div className="h-[300px]">
      <ResponsiveLine
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
              .filter(
                (point) => !filterZeroValues || (point.data.y as number) > 0,
              )
              .map((point) => (
                <div key={point.id} className="flex items-center gap-2">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: point.seriesColor }}
                  />
                  <span className={seriesLabelClassName}>{point.seriesId}</span>
                  <strong className="ml-auto">
                    {formatCurrency(point.data.y as number, 0)}
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
