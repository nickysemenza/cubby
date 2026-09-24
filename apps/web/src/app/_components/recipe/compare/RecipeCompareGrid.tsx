import type {
  MeasureEstimate,
  NutritionTotals,
} from "@cubby/schemas/nutrition";
import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import type { RecipeOut } from "@cubby/schemas/recipe";
import { ChefHatIcon as ChefHat } from "@phosphor-icons/react/dist/csr/ChefHat";
import { EqualsIcon as Equal } from "@phosphor-icons/react/dist/csr/Equals";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

import { stickyRowHeaderCard } from "~/components/matrix/matrix-chrome";
import { Image } from "~/components/ui/image";
import { ChoiceSwitcher } from "~/components/ui/view-switcher";
import { rangeMidpoint } from "~/lib/format-range";
import { scaleEstimate } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
import { costPerNutrient, proteinPer100Kcal } from "~/lib/nutrition-intel";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { formatCurrency } from "~/lib/utils";

import { compactRound } from "../recipe-scaling-pct";
import { RecipeSourceLink, sourceLabel } from "../recipe-source";
import { formatYield, getServingBasis, perUnitSuffix } from "../recipe-utils";
import {
  buildCompareRows,
  type CompareBasis,
  compareRowKey,
  computeStats,
  pickDefaultBasis,
  type RecipeRowMap,
  type Stats,
  sumNullable,
} from "./compare-grid-utils";
import { DistributionGlyph, StripPlotCell } from "./DeviationBar";

/** A recipe plus the figures the comparison grid renders. */
export interface ComparedRecipe {
  recipe: RecipeOut;
  effectiveServings: number | null;
  costing: RecipeCosting | null;
  estimates: NutritionTotals | null;
}

/**
 * Pull one recipe's ingredient rows into the aligned-grid shape, summing any
 * duplicate ingredient lines. Grams and baker's % come straight from the costing
 * engine — which resolves a stated weight ("8½ oz") to grams directly (mass
 * identity, no catalog data needed) and prefers it over a volume that would need
 * a density — so the unit conversions stay in ingredient-parser, not here.
 */
const extractRecipeRows = (costing: RecipeCosting | null): RecipeRowMap => {
  const map: RecipeRowMap = new Map();
  if (!costing) return map;
  for (const row of costing.rows) {
    const name = getRecipeIngredientName(row);
    const key = compareRowKey(name);
    const grams = row.priceInfo?.gram.isOk()
      ? row.priceInfo.gram.value.value
      : null;
    const bakerPct = costing.bakerPct.get(row.id) ?? null;
    const existing = map.get(key);
    if (existing) {
      existing.grams = sumNullable(existing.grams, grams);
      existing.bakerPct = sumNullable(existing.bakerPct, bakerPct);
    } else {
      map.set(key, {
        label: name,
        isFlour: costing.isFlourRows.get(row.id) ?? false,
        grams,
        bakerPct,
      });
    }
  }
  return map;
};

// Shared "1 decimal below 10, whole above" rule (compactRound) so the grid's
// gram/baker-% figures round exactly like the scaling-% labels.
const compareNum = compactRound;

const formatValue = (v: number, basis: CompareBasis): string =>
  basis === "baker" ? `${compareNum(v)}%` : `${compareNum(v)} g`;

/** Mean (with unit) plus a bare-number formatter for the range/σ sub-lines. */
type AverageFormat = {
  mean: (n: number) => string;
  num: (n: number) => string;
};

const ingredientFormat = (basis: CompareBasis): AverageFormat => ({
  mean: (n) => formatValue(n, basis),
  num: (n) => String(compareNum(n)),
});

const numericDetailFormat = (unit: string): AverageFormat => ({
  mean: (n) => `${Math.round(n)}${unit}`,
  num: (n) => String(Math.round(n)),
});

const currencyFormat: AverageFormat = {
  mean: (n) => formatCurrency(n),
  num: (n) => n.toFixed(2),
};

const proteinDensityFormat: AverageFormat = {
  mean: (n) => `${n.toFixed(1)}g`,
  num: (n) => n.toFixed(1),
};

/**
 * The Average column cell: the mean (the "average recipe" value) plus the
 * cross-recipe spread — range, population σ, and coefficient of variation. cv is
 * the at-a-glance "how much do these recipes disagree on this" number.
 */
const AverageCell: React.FC<{
  stats: Stats | null;
  format: AverageFormat;
}> = ({ stats, format }) => {
  if (!stats) return DASH;
  const hasSpread = stats.count >= 2 && stats.max > stats.min;
  return (
    <div className="space-y-1">
      <div className="font-mono font-medium tabular-nums">
        {format.mean(stats.mean)}
      </div>
      {hasSpread && (
        <>
          <div className="font-mono text-2xs leading-tight text-muted-foreground tabular-nums">
            <div>
              {format.num(stats.min)}–{format.num(stats.max)}
            </div>
            <div>
              σ{format.num(stats.std)}
              {stats.cv != null && ` · cv ${Math.round(stats.cv)}%`}
            </div>
          </div>
          <DistributionGlyph
            mean={stats.mean}
            min={stats.min}
            max={stats.max}
            std={stats.std}
          />
        </>
      )}
    </div>
  );
};

const SourceCell: React.FC<{ recipe: RecipeOut }> = ({ recipe }) =>
  sourceLabel(recipe.source) ? (
    <RecipeSourceLink source={recipe.source} />
  ) : (
    <span className="text-muted-foreground">—</span>
  );

const STICKY = stickyRowHeaderCard;

/** One grid row: sticky label, a cell per recipe, and the average cell. */
const GridRow: React.FC<{
  label: ReactNode;
  recipes: ComparedRecipe[];
  renderCell: (c: ComparedRecipe, index: number) => ReactNode;
  average: ReactNode;
}> = ({ label, recipes, renderCell, average }) => (
  <tr className="border-t">
    <th
      scope="row"
      className={`${STICKY} px-2 py-2 text-left align-top font-normal text-muted-foreground`}
    >
      {label}
    </th>
    {recipes.map((c, i) => (
      <td key={c.recipe.id} className="px-2 py-2 align-top">
        {renderCell(c, i)}
      </td>
    ))}
    <td className="border-l-2 border-primary/40 px-2 py-2 align-top text-primary">
      {average}
    </td>
  </tr>
);

const DASH = <span className="text-muted-foreground/40">—</span>;

export const RecipeCompareGrid: React.FC<{
  compared: ComparedRecipe[];
  onRemove: (recipeId: string) => void;
}> = ({ compared, onRemove }) => {
  const perRecipe = useMemo(
    () => compared.map((c) => extractRecipeRows(c.costing)),
    [compared],
  );

  const autoBasis = useMemo(() => pickDefaultBasis(perRecipe), [perRecipe]);
  const [basisOverride, setBasisOverride] = useState<CompareBasis | null>(null);
  const basis = basisOverride ?? autoBasis;

  const ingredientRows = useMemo(
    () => buildCompareRows(perRecipe, basis),
    [perRecipe, basis],
  );

  // Comparisons use complete estimates; an incomplete subtotal is not a
  // comparable complete recipe. Ranges retain their displayed bounds while
  // the distribution statistics use their midpoint.
  const midpoint = (estimate: MeasureEstimate | undefined): number | null =>
    estimate?.status === "complete"
      ? rangeMidpoint(estimate.lower, estimate.upper ?? undefined)
      : null;
  const present = (xs: (number | null)[]): number[] =>
    xs.filter((x): x is number => x != null);
  const servingMidpoint = (c: ComparedRecipe, key: "cost" | "kcal") => {
    const basis = getServingBasis(c.recipe);
    const estimate =
      key === "cost" ? c.estimates?.cost : c.estimates?.nutrition.kcal;
    return estimate && basis
      ? midpoint(scaleEstimate(estimate, 1 / basis.divisor))
      : null;
  };
  const costStats = computeStats(
    present(compared.map((c) => midpoint(c.estimates?.cost))),
  );
  const costPerServingStats = computeStats(
    present(compared.map((c) => servingMidpoint(c, "cost"))),
  );
  const caloriesStats = computeStats(
    present(compared.map((c) => midpoint(c.estimates?.nutrition.kcal))),
  );
  const caloriesPerServingStats = computeStats(
    present(compared.map((c) => servingMidpoint(c, "kcal"))),
  );
  const proteinStats = computeStats(
    present(compared.map((c) => midpoint(c.estimates?.nutrition.protein))),
  );
  const proteinDensity = (c: ComparedRecipe): number | null =>
    proteinPer100Kcal(
      midpoint(c.estimates?.nutrition.protein),
      midpoint(c.estimates?.nutrition.kcal),
    );
  const costPerProteinGram = (c: ComparedRecipe): number | null =>
    costPerNutrient(
      midpoint(c.estimates?.cost),
      midpoint(c.estimates?.nutrition.protein),
    );
  const proteinDensityStats = computeStats(
    present(compared.map(proteinDensity)),
  );
  const costPerProteinStats = computeStats(
    present(compared.map(costPerProteinGram)),
  );

  return (
    <div className="overflow-x-auto border border-[var(--border)] bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-2 py-2">
        <ChoiceSwitcher
          ariaLabel="Comparison basis"
          options={[
            { value: "gram", label: "Grams" },
            { value: "baker", label: "Baker's %" },
          ]}
          value={basis}
          onValueChange={setBasisOverride}
        />
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: "var(--primary)" }}
          />
          largest deviation from average
        </span>
      </div>

      <p className="px-2 py-2 text-xs text-muted-foreground">
        Nutrition averages and ratios use complete estimates; ranges use their
        midpoint.
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th
              aria-label="Recipe"
              className={`${STICKY} z-20 w-32 px-2 pt-2 pb-2`}
            />
            {compared.map((c) => {
              const subtitle = sourceLabel(c.recipe.source);
              const hero = c.recipe.images[0]?.url;
              return (
                <th
                  key={c.recipe.id}
                  className="min-w-[120px] px-2 pt-2 pb-2 text-left align-top font-normal"
                >
                  <div className="relative mb-2">
                    {hero ? (
                      <Image
                        src={hero}
                        alt={c.recipe.name}
                        displayWidth={200}
                        className="h-10 w-full rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-full items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <ChefHat className="size-4" />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemove(c.recipe.id)}
                      aria-label={`Remove ${c.recipe.name} from comparison`}
                      className="absolute top-1 right-1 flex size-11 items-center justify-center rounded-full bg-background/70 text-muted-foreground hover:text-destructive sm:size-5"
                      title="Remove from comparison"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <Link
                    to="/recipes/$shortcode"
                    params={{ shortcode: c.recipe.id }}
                    className="line-clamp-2 min-h-[2.5em] leading-tight font-medium hover:underline"
                  >
                    {c.recipe.name}
                  </Link>
                  {subtitle && (
                    <div className="truncate text-2xs text-muted-foreground">
                      {subtitle}
                    </div>
                  )}
                </th>
              );
            })}
            <th className="min-w-[110px] border-l-2 border-primary/40 px-2 pt-2 pb-2 text-left align-top font-normal">
              <div className="mb-2 flex h-10 w-full items-center justify-center rounded-md bg-primary/10 text-primary">
                <Equal className="size-4" />
              </div>
              <div className="min-h-[2.5em] leading-tight font-medium text-primary">
                Average
              </div>
              <div className="text-2xs text-muted-foreground">
                {compared.length} recipes
              </div>
            </th>
          </tr>
        </thead>

        <tbody>
          {ingredientRows.map((row) => (
            <GridRow
              key={row.key}
              label={
                <span
                  className={
                    row.isFlour ? "font-medium text-foreground" : undefined
                  }
                >
                  {row.label}
                </span>
              }
              recipes={compared}
              renderCell={(_c, i) => {
                const v = row.values[i];
                if (v == null)
                  return <span className="text-muted-foreground/40">·</span>;
                const isMax = row.maxDeviationIndex === i;
                // Absent ingredients (a true 0) read muted so real amounts pop.
                const isZero = v === 0;
                return (
                  <div>
                    <span
                      className={`font-mono tabular-nums ${
                        isMax
                          ? "font-medium"
                          : isZero
                            ? "text-muted-foreground/50"
                            : ""
                      }`}
                      style={isMax ? { color: "var(--primary)" } : undefined}
                    >
                      {formatValue(v, basis)}
                    </span>
                    {row.stats != null &&
                      row.average != null &&
                      row.stats.count >= 2 && (
                        <StripPlotCell
                          value={v}
                          mean={row.average}
                          max={row.stats.max}
                          isMax={isMax}
                        />
                      )}
                  </div>
                );
              }}
              average={
                <AverageCell
                  stats={row.stats}
                  format={ingredientFormat(basis)}
                />
              }
            />
          ))}

          <tr className="border-t bg-muted/30">
            <td
              colSpan={compared.length + 2}
              className={`${STICKY} px-2 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase`}
            >
              Recipe details
            </td>
          </tr>

          <GridRow
            label="Yield"
            recipes={compared}
            renderCell={(c) =>
              c.recipe.yield ? formatYield(c.recipe.yield) : DASH
            }
            average={DASH}
          />
          <GridRow
            label="Servings"
            recipes={compared}
            renderCell={(c) => c.effectiveServings ?? DASH}
            average={DASH}
          />
          <GridRow
            label="Total cost"
            recipes={compared}
            renderCell={(c) =>
              c.estimates
                ? formatEstimate(c.estimates.cost, (value) =>
                    formatCurrency(value),
                  )
                : DASH
            }
            average={<AverageCell stats={costStats} format={currencyFormat} />}
          />
          <GridRow
            label="Cost / serving"
            recipes={compared}
            renderCell={(c) => {
              const sb = getServingBasis(c.recipe);
              const estimate =
                c.estimates && sb
                  ? scaleEstimate(c.estimates.cost, 1 / sb.divisor)
                  : null;
              return estimate && sb ? (
                <span>
                  {formatEstimate(estimate, formatCurrency)}{" "}
                  <span className="text-xs text-muted-foreground">
                    {perUnitSuffix(sb.noun)}
                  </span>
                </span>
              ) : (
                DASH
              );
            }}
            average={
              <AverageCell
                stats={costPerServingStats}
                format={currencyFormat}
              />
            }
          />
          <GridRow
            label="Calories"
            recipes={compared}
            renderCell={(c) =>
              c.estimates
                ? formatEstimate(
                    c.estimates.nutrition.kcal,
                    (n) => `${Math.round(n)} kcal`,
                  )
                : DASH
            }
            average={
              <AverageCell
                stats={caloriesStats}
                format={numericDetailFormat(" kcal")}
              />
            }
          />
          <GridRow
            label="Calories / serving"
            recipes={compared}
            renderCell={(c) => {
              const sb = getServingBasis(c.recipe);
              const estimate =
                c.estimates && sb
                  ? scaleEstimate(c.estimates.nutrition.kcal, 1 / sb.divisor)
                  : null;
              return estimate
                ? formatEstimate(estimate, (n) => `${Math.round(n)} kcal`)
                : DASH;
            }}
            average={
              <AverageCell
                stats={caloriesPerServingStats}
                format={numericDetailFormat(" kcal")}
              />
            }
          />
          <GridRow
            label="Protein"
            recipes={compared}
            renderCell={(c) =>
              c.estimates
                ? formatEstimate(
                    c.estimates.nutrition.protein,
                    (n) => `${Number(n.toFixed(1))} g`,
                  )
                : DASH
            }
            average={
              <AverageCell
                stats={proteinStats}
                format={numericDetailFormat("g")}
              />
            }
          />
          <GridRow
            label="Protein / 100 kcal"
            recipes={compared}
            renderCell={(c) => {
              const v = proteinDensity(c);
              return v != null ? `${v.toFixed(1)}g` : DASH;
            }}
            average={
              <AverageCell
                stats={proteinDensityStats}
                format={proteinDensityFormat}
              />
            }
          />
          <GridRow
            label="Cost / g protein"
            recipes={compared}
            renderCell={(c) => {
              const v = costPerProteinGram(c);
              return v != null ? formatCurrency(v) : DASH;
            }}
            average={
              <AverageCell
                stats={costPerProteinStats}
                format={currencyFormat}
              />
            }
          />
          <GridRow
            label="Costed"
            recipes={compared}
            renderCell={(c) => {
              const estimate = c.estimates?.cost;
              if (!estimate || !hasKnownEstimate(estimate)) return DASH;
              return (
                <span className="text-xs text-muted-foreground">
                  {estimate.coverage.covered}/{estimate.coverage.total}
                </span>
              );
            }}
            average={DASH}
          />
          <GridRow
            label="Source"
            recipes={compared}
            renderCell={(c) => <SourceCell recipe={c.recipe} />}
            average={DASH}
          />
          <GridRow
            label="Tricks"
            recipes={compared}
            renderCell={(c) => {
              const notes = (c.recipe.notes ?? "").trim();
              if (!notes) return DASH;
              const short =
                notes.length > 90 ? `${notes.slice(0, 90).trimEnd()}…` : notes;
              return (
                <span
                  className="text-xs leading-snug text-muted-foreground"
                  title={notes}
                >
                  {short}
                </span>
              );
            }}
            average={DASH}
          />
        </tbody>
      </table>
    </div>
  );
};
