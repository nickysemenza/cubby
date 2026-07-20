import type { PurchaseOut } from "@cubby/schemas/project";
import { useMemo, useState } from "react";
import { Grid, Section, Stack } from "~/components/layout";
import { capitalize, normalizeCostTypeKey } from "../shared";
import { PurchaseDonut } from "./purchase-donut";
import { TradeBars } from "./trade-bars";
import { TradeCostMatrix } from "./trade-cost-matrix";

/**
 * The donut + trade-bars pair with click-to-drill-down: selecting a
 * donut slice scopes the bars (and the donut's center label) to that
 * cost type. Owns its own `Section` wrappers — callers render it bare.
 */
export function CategoryBreakdown({
  purchases,
  donutHeight = 300,
  centerLabel = "Total cost",
}: {
  purchases: PurchaseOut[];
  donutHeight?: number;
  centerLabel?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // Selection can go stale when the purchases set changes underneath us
  // (e.g. a /purchases filter removes the cost type) — derive, don't effect.
  const effectiveSelected =
    selected != null &&
    purchases.some((p) => normalizeCostTypeKey(p.costType) === selected)
      ? selected
      : null;

  const scoped = useMemo(
    () =>
      effectiveSelected
        ? purchases.filter(
            (p) => normalizeCostTypeKey(p.costType) === effectiveSelected,
          )
        : purchases,
    [purchases, effectiveSelected],
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
          <PurchaseDonut
            purchases={purchases}
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
          <TradeBars purchases={scoped} />
        </Section>
      </Grid>
      <Section title="Trade × Cost Type">
        <TradeCostMatrix purchases={purchases} />
      </Section>
    </Stack>
  );
}
