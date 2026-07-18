import type { PurchaseOut } from "@cubby/schemas/project";
import { useMemo, useState } from "react";
import { Grid, Section } from "~/components/layout";
import { capitalize, normalizeCategoryKey } from "../shared";
import { PurchaseDonut } from "./purchase-donut";
import { SubcategoryBars } from "./subcategory-bars";

/**
 * The donut + subcategory-bars pair with click-to-drill-down: selecting a
 * donut slice scopes the bars (and the donut's center label) to that
 * category. Owns its own `Section` wrappers — callers render it bare.
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
  // (e.g. a /purchases filter removes the category) — derive, don't effect.
  const effectiveSelected =
    selected != null &&
    purchases.some((p) => normalizeCategoryKey(p.category) === selected)
      ? selected
      : null;

  const scoped = useMemo(
    () =>
      effectiveSelected
        ? purchases.filter(
            (p) => normalizeCategoryKey(p.category) === effectiveSelected,
          )
        : purchases,
    [purchases, effectiveSelected],
  );

  return (
    <Grid cols="pair">
      <Section
        title="Spending by Category"
        description={
          effectiveSelected
            ? "Click the selected slice again to clear"
            : "Click a slice to drill into its subcategories"
        }
      >
        <PurchaseDonut
          purchases={purchases}
          height={donutHeight}
          centerLabel={centerLabel}
          selectedCategory={effectiveSelected}
          onCategoryClick={(key) =>
            setSelected((current) => (current === key ? null : key))
          }
        />
      </Section>
      <Section
        title={
          effectiveSelected
            ? `${capitalize(effectiveSelected)} — by subcategory`
            : "Spending by Subcategory"
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
        <SubcategoryBars purchases={scoped} />
      </Section>
    </Grid>
  );
}
