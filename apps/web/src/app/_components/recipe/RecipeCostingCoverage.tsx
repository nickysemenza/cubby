import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
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
 * The deep-link target that fixes a gap: an ingredient row routes to the
 * enrichment workbench (focused on that ingredient); a sub-recipe row routes to
 * the child (or, for a missing amount, the current recipe's editor). Extracted
 * so the coverage popover *and* the per-row "missing cost" cell in the
 * ingredient list point at the exact same fix — one source of truth.
 */
function gapFixLinkProps(gap: RecipeTotalsGap, currentRecipeShortcode: string) {
  if (gap.source === "ingredient") {
    return {
      to: "/ingredients/workbench" as const,
      search: { focus: gap.ingredientId },
    };
  }
  const edit =
    gap.kind === "set-subrecipe-amount" || gap.kind === "set-subrecipe-yield";
  return {
    to: "/recipes/$shortcode" as const,
    params: {
      shortcode:
        gap.kind === "set-subrecipe-amount"
          ? currentRecipeShortcode
          : gap.recipeShortcode,
    },
    search: { edit: edit ? true : undefined },
  };
}

/**
 * The per-ingredient gap list, shared by the inline card and the popover. Each
 * row shows the ingredient, what's missing (per-measure chips), the suggested
 * fix, and a deep-link to that ingredient's row in the enrichment workbench —
 * the one place all ingredient enrichment now happens.
 */
function TotalsGapAction({
  gap,
  currentRecipeShortcode,
  cta,
}: {
  gap: RecipeTotalsGap;
  currentRecipeShortcode: string;
  cta: string;
}) {
  return (
    <Link
      {...gapFixLinkProps(gap, currentRecipeShortcode)}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
    >
      {cta}
      <ArrowRightIcon className="ml-1 size-3" />
    </Link>
  );
}

function TotalsGapList({
  gaps,
  currentRecipeShortcode,
}: {
  gaps: RecipeTotalsGap[];
  currentRecipeShortcode: string;
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
                <span className="text-sm font-medium">{gap.name}</span>
                {missing.map((c) => (
                  <Badge
                    key={c.key}
                    variant="outline"
                    className="border-warning/40 px-2 py-0 text-2xs font-normal text-warning-ink"
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
              currentRecipeShortcode={currentRecipeShortcode}
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
  currentRecipeShortcode,
  open,
  onOpenChange,
  resolved = true,
}: {
  gaps: RecipeTotalsGap[];
  /** Scopes the "Open all in workbench" link — the workbench filters by id, not shortcode. */
  currentRecipeId: string;
  currentRecipeShortcode: string;
  /** URL-driven when arriving from the understated-cost Problem card. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Do not clear a deep link while live costing data is still loading. */
  resolved?: boolean;
}) {
  const hasGaps = gaps.length > 0;

  // A persisted Problem can be stale by the time its detail link is opened.
  // Once the live costing pass confirms there are no blockers, remove the URL
  // state instead of leaving a non-functional `costingGap` bookmark behind.
  useEffect(() => {
    if (resolved && !hasGaps && open) onOpenChange?.(false);
  }, [hasGaps, onOpenChange, open, resolved]);

  if (!hasGaps) return null;

  // Roll the per-measure gaps up into category counts for the popover header —
  // the breakdown the summary card's "Missing data" footer used to show.
  const counts = MISSING_CHIPS.map((c) => ({
    label: c.label,
    n: gaps.filter((g) => g.missing[c.key]).length,
  })).filter((c) => c.n > 0);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-2 border border-warning/40 px-2 py-1 text-xs text-warning-ink hover:bg-warning/10",
        )}
      >
        <WarningIcon className="size-3.5" />
        {gaps.length} block totals
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle>Why aren&apos;t these totals complete?</PopoverTitle>
          <Row align="center" wrap gap="sm" className="pt-1">
            {counts.map((c) => (
              <span key={c.label} className="eyebrow">
                {c.label}
                <span className="ml-1 text-warning-ink">{c.n}</span>
              </span>
            ))}
          </Row>
        </PopoverHeader>
        <TotalsGapList
          gaps={gaps}
          currentRecipeShortcode={currentRecipeShortcode}
        />
        <Link
          to="/ingredients/workbench"
          search={{ recipe: currentRecipeId }}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "mt-4 w-full justify-center gap-2",
          )}
        >
          Open all in workbench
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The per-row replacement for the inert muted em-dash in the ingredient list's
 * Cost/Weight cells. When the engine couldn't resolve a measure *and* we have a
 * prioritized fix for that ingredient, render a warning-toned em-dash that
 * deep-links straight to the fix (the same target as the coverage popover) —
 * so a missing cost is tappable on touch, not just a hover `title`. When there's
 * no actionable gap (e.g. an intentionally unmeasured line), falls back to the
 * plain muted placeholder.
 */
export function MissingMeasureCell({
  gap,
  currentRecipeShortcode,
  reason,
}: {
  gap: RecipeTotalsGap | undefined;
  currentRecipeShortcode: string;
  /** The engine's error string, surfaced on hover for detail. */
  reason: string;
}) {
  if (!gap) {
    return (
      <span className="cursor-default text-muted-foreground" title={reason}>
        —
      </span>
    );
  }
  const { lead } = suggestionFor(gap);
  return (
    <Link
      {...gapFixLinkProps(gap, currentRecipeShortcode)}
      title={`${reason} — ${lead}`}
      className="text-warning-ink underline decoration-dotted underline-offset-2 hover:text-warning-ink/80"
    >
      —
    </Link>
  );
}
