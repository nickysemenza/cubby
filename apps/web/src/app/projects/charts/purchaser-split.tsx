import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { sumBy } from "es-toolkit";
import { Users } from "lucide-react";
import { useMemo } from "react";
import { purchaserLabels } from "~/app/purchases/purchase-options";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import {
  getPurchaserColor,
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type PurchaserDatum = {
  purchaser: string;
  label: string;
  value: number;
  color: string;
};

/** Spend split by who bought it (nicky / rebecca / both / unassigned). */
export function PurchaserSplit({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => {
    const byPurchaser = sumByKey(
      purchases,
      (p) => p.purchaser ?? "unassigned",
      (p) => p.cost,
    );
    const labels = purchaserLabels as Record<string, string>;
    return Array.from(byPurchaser.entries())
      .filter(([, value]) => value > 0)
      .map(
        ([purchaser, value]): PurchaserDatum => ({
          purchaser,
          label: labels[purchaser] ?? "Unassigned",
          value,
          color: getPurchaserColor(
            purchaser === "unassigned" ? null : purchaser,
          ),
        }),
      )
      .sort((a, b) => a.value - b.value); // ascending → largest bar renders on top
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={Users} title="No purchase data." />;
  }

  const total = sumBy(data, (d) => d.value);
  const chartHeight = data.length * 48 + 60;

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["value"]}
        indexBy="label"
        layout="horizontal"
        margin={{ top: 10, right: 60, bottom: 40, left: 100 }}
        padding={0.25}
        colors={(bar) => bar.data.color}
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={40}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        tooltip={({ value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong>:{" "}
            <span style={{ color }}>{formatCurrency(value, 0)}</span> (
            {((value / total) * 100).toFixed(1)}%)
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
    </div>
  );
}
