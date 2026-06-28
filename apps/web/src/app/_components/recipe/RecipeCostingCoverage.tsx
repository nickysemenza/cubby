import { Link } from "@tanstack/react-router";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { match } from "ts-pattern";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import type { LineKind, RecipeTotalsGap } from "~/lib/recipe-totals-gaps";
import { cn } from "~/lib/utils";

/** Example package mapping to show, matched to how the recipe line measures. */
const purchaseExample = (lineKind: LineKind): string =>
  lineKind === "volume" ? "1 qt = $4.00" : "4 oz = $5.99";

/**
 * The prioritized suggestion copy for a gap. `lead` is the specific thing to
 * add; `cta` is the link label. USDA is preferred wherever it applies (it adds
 * portions + nutrition at once); the price variants are unit-aware.
 */
const suggestionFor = (gap: RecipeTotalsGap): { lead: string; cta: string } =>
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
      // arm exists only to keep the match exhaustive over the shared totals kind.
      lead: "Add a volume mapping (e.g. 1 cup = 240 ml) — or link a USDA food for portions.",
      cta: "Add mapping",
    }))
    .with({ kind: "set-subrecipe-amount" }, () => ({
      lead: "Set how much of this sub-recipe is used so it can be scaled into these totals.",
      cta: "Edit recipe",
    }))
    .with({ kind: "set-subrecipe-yield" }, () => ({
      lead: "Set the sub-recipe yield so this recipe can scale its totals.",
      cta: "Set yield",
    }))
    .with({ kind: "fix-subrecipe-totals" }, () => ({
      lead: "This sub-recipe has incomplete totals. Open it to fix the underlying ingredients.",
      cta: "Open recipe",
    }))
    .exhaustive();

/** The measures the engine couldn't resolve, as small chips. */
const MISSING_CHIPS: {
  key: keyof RecipeTotalsGap["missing"];
  label: string;
}[] = [
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
function TotalsGapAction({
  gap,
  currentRecipeId,
  cta,
}: {
  gap: RecipeTotalsGap;
  currentRecipeId: string;
  cta: string;
}) {
  if (gap.source === "ingredient") {
    return (
      <Link
        to="/ingredients/workbench"
        search={{ focus: gap.ingredientId }}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        {cta}
        <ArrowRight className="ml-1 h-3 w-3" />
      </Link>
    );
  }

  const edit =
    gap.kind === "set-subrecipe-amount" || gap.kind === "set-subrecipe-yield";
  return (
    <Link
      to="/recipes/$id"
      params={{
        id:
          gap.kind === "set-subrecipe-amount" ? currentRecipeId : gap.recipeId,
      }}
      search={{ edit: edit ? true : undefined }}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
    >
      {cta}
      <ArrowRight className="ml-1 h-3 w-3" />
    </Link>
  );
}

function TotalsGapList({
  gaps,
  currentRecipeId,
}: {
  gaps: RecipeTotalsGap[];
  currentRecipeId: string;
}) {
  return (
    <ul className="divide-y divide-border/60">
      {gaps.map((gap) => {
        const { lead, cta } = suggestionFor(gap);
        const missing = MISSING_CHIPS.filter((c) => gap.missing[c.key]);
        return (
          <Row
            as="li"
            align="center"
            justify="between"
            wrap
            gap="sm"
            key={gap.source === "ingredient" ? gap.ingredientId : gap.rowId}
            className="py-2"
          >
            <div className="min-w-0 flex-1">
              <Row align="center" wrap gap="sm">
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
              </Row>
              <Description as="div" size="2xs" className="leading-snug">
                {lead}
              </Description>
            </div>
            <TotalsGapAction
              gap={gap}
              currentRecipeId={currentRecipeId}
              cta={cta}
            />
          </Row>
        );
      })}
    </ul>
  );
}

/**
 * The gap list as a compact, view-independent affordance — a "N block totals"
 * button that opens the list in a popover. Shown on every recipe view (the bulky
 * inline card was retired), so "why aren't these totals complete?" is always one
 * click away without taking over the layout.
 */
export function RecipeTotalsCoverageButton({
  gaps,
  currentRecipeId,
}: {
  gaps: RecipeTotalsGap[];
  currentRecipeId: string;
}) {
  if (gaps.length === 0) return null;

  // Roll the per-measure gaps up into category counts for the popover header —
  // the breakdown the summary card's "Missing data" footer used to show.
  const counts = MISSING_CHIPS.map((c) => ({
    label: c.label,
    n: gaps.filter((g) => g.missing[c.key]).length,
  })).filter((c) => c.n > 0);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-warning/40 px-2 py-1 text-warning text-xs hover:bg-warning/10",
        )}
      >
        <TriangleAlert className="h-3.5 w-3.5" />
        {gaps.length} block totals
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle>Why aren&apos;t these totals complete?</PopoverTitle>
          <Row align="center" wrap gap="sm" className="pt-1">
            {counts.map((c) => (
              <span
                key={c.label}
                className="font-mono text-2xs text-muted-foreground uppercase tracking-wide"
              >
                {c.label}
                <span className="ml-1 text-warning">{c.n}</span>
              </span>
            ))}
          </Row>
        </PopoverHeader>
        <TotalsGapList gaps={gaps} currentRecipeId={currentRecipeId} />
      </PopoverContent>
    </Popover>
  );
}
