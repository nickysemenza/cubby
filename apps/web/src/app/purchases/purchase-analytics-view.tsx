import type { CostType, Trade } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Grid, Section, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { StatTile } from "~/components/ui/stat-tile";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import { CostTypeDonut } from "./charts/cost-type-donut";
import { CumulativeSpend } from "./charts/cumulative-spend";
import { MonthlySpend } from "./charts/monthly-spend";
import { ProjectBreakdown } from "./charts/project-breakdown";
import type { AggregateMatrixCell } from "./charts/trade-cost-aggregate";
import {
  TradeBarsAggregate,
  TradeCostMatrixAggregate,
} from "./charts/trade-cost-aggregate";
import { purchaseFiltersFromSearch } from "./purchase-options";

const route = getRouteApi("/_authenticated/purchases/");

/**
 * `view=analytics` — chart-first read over `purchase.analytics`'s
 * server-side aggregates (see packages/schemas/src/project.ts's
 * `purchaseAnalyticsOut`), replacing the old always-mounted
 * `PurchaseChartStrip` (which fetched every matching row via
 * `purchase.chartData` and grouped client-side).
 *
 * Filters are read straight off the route's URL search params via
 * `purchaseFiltersFromSearch` — the SAME conversion `purchaselist.tsx`'s
 * ledger table uses to seed + live-sync its own column filters — so this
 * view's totals always agree with the Ledger view's, and a Trade × Cost Type
 * matrix click here writes back to those same params (switching to Ledger
 * afterwards shows the matching rows).
 */
export function PurchaseAnalyticsView() {
  const api = useTRPC();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [selectedCostType, setSelectedCostType] = useState<string | null>(null);

  const filters = purchaseFiltersFromSearch(search);

  const { data, isLoading } = useQuery({
    ...api.purchase.analytics.queryOptions(filters),
    staleTime: 60 * 1000,
  });

  const activeCell: AggregateMatrixCell | null = filters.trade
    ? { trade: filters.trade, costType: filters.costType ?? null }
    : null;

  const handleCellClick = useCallback(
    (trade: Trade, costType: CostType | null) => {
      const clear =
        activeCell?.trade === trade && activeCell.costType === costType;
      void navigate({
        search: (prev) => ({
          ...prev,
          trade: clear ? undefined : trade,
          costType: clear || costType === null ? undefined : costType,
        }),
        replace: true,
      });
    },
    [navigate, activeCell],
  );

  if (isLoading || !data) {
    return (
      <Stack gap="lg">
        <Grid cols="summary">
          {["actual", "committed", "credits", "net", "count"].map((key) => (
            <Skeleton key={key} className="h-14 w-full" />
          ))}
        </Grid>
        <Skeleton className="h-[300px] w-full" />
      </Stack>
    );
  }

  const {
    summary,
    byCostType,
    tradeCostMatrix,
    monthly,
    cumulative,
    byProject,
  } = data;

  return (
    <Stack gap="lg">
      <Grid cols="summary">
        <StatTile label="Actual">{formatCurrency(summary.actual, 0)}</StatTile>
        <StatTile label="Committed">
          {formatCurrency(summary.committed, 0)}
        </StatTile>
        <StatTile label="Credits">
          {formatCurrency(summary.credits, 0)}
        </StatTile>
        <StatTile label="Net">{formatCurrency(summary.net, 0)}</StatTile>
        <StatTile label="Count">{summary.count}</StatTile>
      </Grid>

      <Grid cols="pair">
        <Section
          title="Spending by Category"
          description="Click a slice to scope the trade breakdown"
        >
          <CostTypeDonut
            byCostType={byCostType}
            selected={selectedCostType}
            onSelect={(key) =>
              setSelectedCostType((current) => (current === key ? null : key))
            }
          />
        </Section>
        <Section
          title="Spending by Trade"
          description={
            selectedCostType ? (
              <button
                type="button"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
                onClick={() => setSelectedCostType(null)}
              >
                Clear selection
              </button>
            ) : undefined
          }
        >
          <TradeBarsAggregate
            tradeCostMatrix={
              selectedCostType
                ? tradeCostMatrix.filter(
                    (row) => row.costType === selectedCostType,
                  )
                : tradeCostMatrix
            }
          />
        </Section>
      </Grid>

      <Section
        title="Trade × Cost Type"
        description="Click a cell to filter the Ledger view; click it again to clear"
      >
        <TradeCostMatrixAggregate
          tradeCostMatrix={tradeCostMatrix}
          onCellClick={handleCellClick}
          activeCell={activeCell}
        />
      </Section>

      <Section
        title="Monthly Spend"
        description="Net spend per calendar month — recurring installments and spend rhythm show up as a repeating pattern. Negative months (refunds, credits) render below the axis."
      >
        <MonthlySpend monthly={monthly} />
      </Section>

      <Section
        title="Cumulative Spend"
        description="Running net total across the filtered set."
      >
        <CumulativeSpend cumulative={cumulative} />
      </Section>

      {byProject.length > 0 && (
        <Section title="By Project" description="Net spend per project.">
          <ProjectBreakdown byProject={byProject} />
        </Section>
      )}
    </Stack>
  );
}
