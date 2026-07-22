import type {
  PurchaseFilters,
  PurchaseOut,
  Trade,
} from "@cubby/schemas/project";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense } from "react";
import type { TradeCostCell } from "~/app/projects/charts/trade-cost-matrix";
import type { PivotCostKey } from "~/app/projects/charts/trade-cost-pivot";
import { Grid, Section, Stack } from "~/components/layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { StatTile } from "~/components/ui/stat-tile";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";

// Nivo is heavy — keep it out of the /purchases initial chunk; it only loads
// when the (persisted-open) strip actually renders charts.
const CategoryBreakdown = lazy(() =>
  import("~/app/projects/charts/category-breakdown").then((m) => ({
    default: m.CategoryBreakdown,
  })),
);

// Temporal lens over the same filtered set. No whole-purchases cost estimate
// exists, so `costEstimate` is null — the chart degrades gracefully (no
// over-budget marker, neutral point coloring). Negative-safe by design.
const SpendingOverTime = lazy(() =>
  import("~/app/projects/charts/spending-over-time").then((m) => ({
    default: m.SpendingOverTime,
  })),
);

// Cadence lens: net spend bucketed by calendar month — surfaces recurring
// installments and spend rhythm that a cumulative curve smooths away.
const MonthlySpend = lazy(() =>
  import("~/app/purchases/charts/monthly-spend").then((m) => ({
    default: m.MonthlySpend,
  })),
);

const NO_PURCHASES: PurchaseOut[] = [];

/**
 * Collapsible chart panel above the purchases table that aggregates the FULL
 * filtered set (not just the visible page) — the Notion-style "charts over a
 * filtered view". Open/closed state persists across visits.
 */
export function PurchaseChartStrip({
  filters,
  onMatrixCellClick,
  activeMatrixCell,
}: {
  filters: PurchaseFilters;
  onMatrixCellClick?: (trade: Trade, costType: PivotCostKey | null) => void;
  activeMatrixCell?: TradeCostCell | null;
}) {
  const api = useTRPC();
  const [open, setOpen] = useLocalStorage("purchases:charts-open", true);

  const { data, isLoading } = useQuery({
    ...api.purchase.chartData.queryOptions(filters),
    staleTime: 60 * 1000,
    // Filter changes morph the charts in place instead of flashing empty.
    placeholderData: keepPreviousData,
    enabled: open,
  });
  const purchases = data ?? NO_PURCHASES;

  const total = sumBy(purchases, (p) => p.cost ?? 0);
  const planned = sumBy(
    purchases.filter((p) => p.future),
    (p) => p.cost ?? 0,
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border border-b pb-4"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-2 text-left">
        <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground transition-transform group-data-[panel-open]:rotate-0" />
        <span className="font-heading font-semibold text-lg">Charts</span>
        {open && !isLoading && purchases.length > 0 && (
          <span className="font-mono text-muted-foreground text-xs tabular-nums">
            {formatCurrency(total, 0)} across {purchases.length} purchases
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : (
          <Stack>
            <Grid cols="summary">
              <StatTile label="Total cost">{formatCurrency(total, 0)}</StatTile>
              <StatTile label="Purchases">{purchases.length}</StatTile>
              <StatTile label="Planned">{formatCurrency(planned, 0)}</StatTile>
            </Grid>
            <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
              <CategoryBreakdown
                purchases={purchases}
                donutHeight={280}
                centerLabel="Filtered total"
                onMatrixCellClick={onMatrixCellClick}
                activeMatrixCell={activeMatrixCell}
              />
            </Suspense>
            <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
              <SpendingOverTime purchases={purchases} costEstimate={null} />
            </Suspense>
            <Section
              title="Monthly Spend"
              description="Net spend per calendar month — recurring installments and spend rhythm show up as a repeating pattern. Negative months (refunds, credits) render below the axis."
            >
              <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
                <MonthlySpend purchases={purchases} />
              </Suspense>
            </Section>
          </Stack>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
