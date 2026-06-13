import { Link } from "@tanstack/react-router";
import { ArrowRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { match } from "ts-pattern";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import type { CostingGap, LineKind } from "~/lib/recipe-costing-gaps";
import { cn } from "~/lib/utils";
import { EnrichIngredientDialog } from "../ingredients/enrich-ingredient-dialog";

/** Example package mapping to show, matched to how the recipe line measures. */
const purchaseExample = (lineKind: LineKind): string =>
  lineKind === "volume" ? "1 qt = $4.00" : "4 oz = $5.99";

/**
 * The prioritized suggestion copy for a gap. `lead` is the specific thing to
 * add; `cta` is the link/button label. USDA is preferred wherever it applies
 * (it adds portions + nutrition at once); the price variants are unit-aware.
 */
const suggestionFor = (gap: CostingGap): { lead: string; cta: string } =>
  match(gap)
    .with({ kind: "no-product" }, () => ({
      lead: "No product linked. Link one (with a USDA food) to cost it.",
      cta: "Link product",
    }))
    .with({ kind: "link-usda" }, () => ({
      lead: "Link a USDA food — adds weight & nutrition conversions automatically.",
      cta: "Link USDA",
    }))
    .with({ kind: "set-per-item-price" }, () => ({
      // A count line could be a discrete item (priced per each) or something
      // sold by weight ("1 clove" of a head of garlic) — so offer both rather
      // than assert it's sold individually.
      lead: "Set a per-item price (if sold individually) or add a purchase mapping.",
      cta: "Add price",
    }))
    .with({ kind: "add-purchase-mapping" }, (gap) => ({
      lead: `No price path for this ${gap.lineKind} line. Add a purchase mapping (e.g. ${purchaseExample(gap.lineKind)}).`,
      cta: "Add mapping",
    }))
    .with({ kind: "add-weight-mapping" }, () => ({
      lead: "Add a weight mapping (e.g. 1 cup = 120 g) — or link a USDA food for portions.",
      cta: "Add mapping",
    }))
    .exhaustive();

/**
 * "Improve costing coverage" panel: lists the recipe's uncosted ingredients,
 * each with its single highest-leverage suggested fix (derived once in
 * {@link deriveCostingGaps}). Ingredients with no product open the shared
 * {@link EnrichIngredientDialog} in place (link a product + USDA + price);
 * everything else deep-links to the product edit form (single product) or the
 * ingredient hub (multiple), where the USDA search, price, and mapping fields
 * already live. Render only when `gaps` is non-empty.
 */
export function RecipeCostingCoverage({ gaps }: { gaps: CostingGap[] }) {
  const [enrichTarget, setEnrichTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  if (gaps.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Improve costing coverage
        </CardTitle>
        <p className="text-muted-foreground text-sm">
          {gaps.length} ingredient{gaps.length === 1 ? "" : "s"} can&apos;t be
          fully costed yet. Linking a USDA food adds the most conversions at
          once.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60">
          {gaps.map((gap) => {
            const { lead, cta } = suggestionFor(gap);
            return (
              <li
                key={gap.ingredientId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{gap.name}</div>
                  <div className="text-2xs text-muted-foreground leading-snug">
                    {lead}
                  </div>
                </div>
                {gap.kind === "no-product" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEnrichTarget({ id: gap.ingredientId, name: gap.name })
                    }
                  >
                    {cta}
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                ) : (
                  <Link
                    to={gap.productId ? "/products/$id" : "/ingredients/$id"}
                    params={{ id: gap.productId ?? gap.ingredientId }}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    {cta}
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>

      {/* Shared enrich flow for ingredients with no product (create + USDA + price). */}
      <EnrichIngredientDialog
        ingredient={enrichTarget}
        onOpenChange={(open) => {
          if (!open) setEnrichTarget(null);
        }}
      />
    </Card>
  );
}
