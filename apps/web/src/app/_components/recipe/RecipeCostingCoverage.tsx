import { Link } from "@tanstack/react-router";
import { ArrowRight, Sparkles, TriangleAlert } from "lucide-react";
import { match } from "ts-pattern";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import type { CostingGap, LineKind } from "~/lib/recipe-costing-gaps";
import { cn } from "~/lib/utils";

/** Example package mapping to show, matched to how the recipe line measures. */
const purchaseExample = (lineKind: LineKind): string =>
  lineKind === "volume" ? "1 qt = $4.00" : "4 oz = $5.99";

/**
 * The prioritized suggestion copy for a gap. `lead` is the specific thing to
 * add; `cta` is the link label. USDA is preferred wherever it applies (it adds
 * portions + nutrition at once); the price variants are unit-aware.
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
    .with({ kind: "add-volume-mapping" }, () => ({
      // The per-recipe path never emits this (volume isn't a costing blocker); the
      // arm exists only to keep the match exhaustive over the shared CostingGapKind.
      lead: "Add a volume mapping (e.g. 1 cup = 240 ml) — or link a USDA food for portions.",
      cta: "Add mapping",
    }))
    .exhaustive();

/** The measures the engine couldn't resolve, as small chips. */
const MISSING_CHIPS: { key: keyof CostingGap["missing"]; label: string }[] = [
  { key: "price", label: "price" },
  { key: "weight", label: "weight" },
  { key: "nutrients", label: "nutrition" },
];

/**
 * The per-ingredient gap list, shared by the inline card and the popover. Each
 * row shows the ingredient, what's missing (per-measure chips), the suggested
 * fix, and a deep-link to that ingredient's row in the enrichment workbench —
 * the one place all ingredient enrichment now happens.
 */
function CostingGapList({ gaps }: { gaps: CostingGap[] }) {
  return (
    <ul className="divide-y divide-border/60">
      {gaps.map((gap) => {
        const { lead, cta } = suggestionFor(gap);
        const missing = MISSING_CHIPS.filter((c) => gap.missing[c.key]);
        return (
          <li
            key={gap.ingredientId}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{gap.name}</span>
                {missing.map((c) => (
                  <Badge
                    key={c.key}
                    variant="outline"
                    className="border-warning/40 px-2 py-0 font-normal text-2xs text-warning"
                  >
                    {c.label}
                  </Badge>
                ))}
              </div>
              <div className="text-2xs text-muted-foreground leading-snug">
                {lead}
              </div>
            </div>
            <Link
              to="/ingredients/workbench"
              search={{ focus: gap.ingredientId }}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              {cta}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Improve costing coverage" panel: the recipe's uncosted ingredients, each with
 * its single highest-leverage fix (derived once in {@link deriveCostingGaps}),
 * what's missing, and a deep-link into the workbench. Render only when `gaps` is
 * non-empty; used inline in the table/charts views where cost matters.
 */
export function RecipeCostingCoverage({ gaps }: { gaps: CostingGap[] }) {
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
        <CostingGapList gaps={gaps} />
      </CardContent>
    </Card>
  );
}

/**
 * The same gap list as a compact, view-independent affordance — a "N block
 * costing" button that opens the list in a popover. Shown in the reader-facing
 * views (magazine/spec/prep/…) where the full inline card would intrude, so
 * "why isn't this fully costed?" is always one click away.
 */
export function CostingCoverageButton({ gaps }: { gaps: CostingGap[] }) {
  if (gaps.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-warning/40 px-2 py-1 text-warning text-xs hover:bg-warning/10",
        )}
      >
        <TriangleAlert className="h-3.5 w-3.5" />
        {gaps.length} block costing
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle>Why isn&apos;t this fully costed?</PopoverTitle>
        </PopoverHeader>
        <CostingGapList gaps={gaps} />
      </PopoverContent>
    </Popover>
  );
}
