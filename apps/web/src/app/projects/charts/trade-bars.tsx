import { isPrincipalExpense } from "@cubby/schemas/expense-line-kind";
import type { ExpenseOut, Trade } from "@cubby/schemas/project";
import { ShoppingBagIcon as ShoppingBag } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { useMemo } from "react";

import { HorizontalBarChart } from "~/app/_components/charts/kit";
import { Stack } from "~/components/layout";
import { formatCurrency } from "~/lib/utils";

import {
  getCostTypeColor,
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
  TRADE_LABELS,
} from "../shared";
import { ChartEmpty } from "./chart-empty";
import { ChartTooltip, TooltipExpenseBreakdown } from "./ChartTooltip";
import { buildTradeCostPivot, PIVOT_COST_KEYS } from "./trade-cost-pivot";

type BarDatum = {
  trade: string;
  materials: number;
  tools: number;
  services: number;
  total: number;
};

const isTrade = (value: string): value is Trade => value in TRADE_LABELS;
const tradeLabel = (value: string): string =>
  isTrade(value) ? TRADE_LABELS[value] : value;
const tradeKey = (trade: Trade | null): string =>
  trade === null ? "Unassigned trade" : trade;

export function TradeBars({ expenses }: { expenses: ExpenseOut[] }) {
  const { data, hiddenCount, expensesByCell } = useMemo(() => {
    const { rows } = buildTradeCostPivot(expenses);
    // Stacked bars can't render negative-net rows — drop them here (the
    // matrix keeps them). The helper sorts total DESC, but nivo horizontal
    // bars render bottom-up — reverse to keep the biggest-on-top visual.
    const data: BarDatum[] = rows
      .filter((row) => row.total > 0)
      .map((row) => ({
        trade: tradeKey(row.trade),
        ...row.cells,
        total: row.total,
      }))
      .reverse();

    // Trades with a net ≤ $0 (refunds/credits net out the spend) are dropped
    // above — surface the count so their absence isn't silent.
    const hiddenCount = rows.filter((row) => row.total <= 0).length;

    // Expenses behind each `trade|costType` segment, for the tooltip.
    const expensesByCell = new Map<string, ExpenseOut[]>();
    for (const p of expenses) {
      if (!isPrincipalExpense(p)) continue;
      const key = `${tradeKey(p.trade)}|${p.costType}`;
      const list = expensesByCell.get(key);
      if (list) list.push(p);
      else expensesByCell.set(key, [p]);
    }
    return { data, hiddenCount, expensesByCell };
  }, [expenses]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No expense data." />;
  }

  return (
    <Stack gap="tight">
      <HorizontalBarChart
        data={data}
        minHeight={300}
        keys={[...PIVOT_COST_KEYS]}
        indexBy="trade"
        margin={{ top: 10, right: 60, bottom: 40, left: 200 }}
        padding={0.25}
        colors={(bar) => getCostTypeColor(String(bar.id))}
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          format: tradeLabel,
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={40}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        tooltip={({ id, value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{tradeLabel(String(indexValue))}</strong> — {id}:{" "}
            <span style={{ color }}>{formatCurrency(value, 0)}</span>
            <TooltipExpenseBreakdown
              expenses={expensesByCell.get(`${indexValue}|${id}`) ?? []}
            />
          </ChartTooltip>
        )}
        legends={[
          {
            dataFrom: "keys",
            anchor: "bottom",
            direction: "row",
            translateY: 40,
            itemWidth: 100,
            itemHeight: 20,
            symbolSize: 12,
            symbolShape: "circle",
            itemTextColor: "var(--muted-foreground)",
          },
        ]}
        theme={nivoChartTheme}
      />
      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {hiddenCount} trade{hiddenCount === 1 ? "" : "s"} with net ≤ $0 hidden
          (refunds/credits).
        </p>
      )}
    </Stack>
  );
}
