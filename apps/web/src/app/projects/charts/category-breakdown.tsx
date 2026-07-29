import type { ExpenseOut, Trade } from "@cubby/schemas/project";
import { useMemo, useState } from "react";
import { Grid, Section, Stack } from "~/components/layout";
import { capitalize, normalizeCostTypeKey } from "../shared";
import { ExpenseDonut } from "./expense-donut";
import { TradeBars } from "./trade-bars";
import { type TradeCostCell, TradeCostMatrix } from "./trade-cost-matrix";
import type { PivotCostKey } from "./trade-cost-pivot";

/**
 * The donut + trade-bars pair with click-to-drill-down: selecting a
 * donut slice scopes the bars (and the donut's center label) to that
 * cost type. Owns its own `Section` wrappers — callers render it bare.
 */
export function CategoryBreakdown({
  expenses,
  donutHeight = 300,
  centerLabel = "Total cost",
  onMatrixCellClick,
  activeMatrixCell,
}: {
  expenses: ExpenseOut[];
  donutHeight?: number;
  centerLabel?: string;
  onMatrixCellClick?: (trade: Trade, costType: PivotCostKey | null) => void;
  activeMatrixCell?: TradeCostCell | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // Selection can go stale when the expenses set changes underneath us
  // (e.g. a /expenses filter removes the cost type) — derive, don't effect.
  const effectiveSelected =
    selected != null &&
    expenses.some((p) => normalizeCostTypeKey(p.costType) === selected)
      ? selected
      : null;

  const scoped = useMemo(
    () =>
      effectiveSelected
        ? expenses.filter(
            (p) => normalizeCostTypeKey(p.costType) === effectiveSelected,
          )
        : expenses,
    [expenses, effectiveSelected],
  );

  return (
    <Stack>
      <Grid cols="pair">
        <Section
          title="Spending by Category"
          description={
            effectiveSelected
              ? "Click the selected slice again to clear"
              : "Click a slice to drill into its trades"
          }
        >
          <ExpenseDonut
            expenses={expenses}
            height={donutHeight}
            centerLabel={centerLabel}
            selectedCostType={effectiveSelected}
            onCostTypeClick={(key) =>
              setSelected((current) => (current === key ? null : key))
            }
          />
        </Section>
        <Section
          title={
            effectiveSelected
              ? `${capitalize(effectiveSelected)} — by trade`
              : "Spending by Trade"
          }
          description={
            effectiveSelected ? (
              <button
                type="button"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
                onClick={() => setSelected(null)}
              >
                Clear selection
              </button>
            ) : undefined
          }
        >
          <TradeBars expenses={scoped} />
        </Section>
      </Grid>
      <Section
        title="Trade × Cost Type"
        description={
          onMatrixCellClick
            ? "Click a cell to filter the table; click it again to clear"
            : undefined
        }
      >
        <TradeCostMatrix
          expenses={expenses}
          onCellClick={onMatrixCellClick}
          activeCell={activeMatrixCell}
        />
      </Section>
    </Stack>
  );
}
