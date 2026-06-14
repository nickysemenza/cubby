import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import { BookOpen, ChefHat, Equal, ExternalLink, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { match } from "ts-pattern";
import {
  formatCurrencyRange,
  formatNumberRange,
  rangeMidpoint,
} from "~/lib/format-range";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { formatCurrency } from "~/lib/utils";
import {
  formatYield,
  getServingBasis,
  perUnitSuffix,
  type RecipeHeadlineTotals,
} from "../recipe-utils";
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
  headline: RecipeHeadlineTotals | null;
  effectiveServings: number | null;
  costing: RecipeCosting | null;
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

// One decimal below 10 so small-but-real amounts (salt, leavening) don't read as
// a misleading round number; whole units above.
const compareNum = (v: number): number =>
  v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;

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
    <div className="space-y-0.5">
      <div className="font-medium font-mono tabular-nums">
        {format.mean(stats.mean)}
      </div>
      {hasSpread && (
        <>
          <div className="font-mono text-[11px] text-muted-foreground tabular-nums leading-tight">
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

const sourceSubtitle = (recipe: RecipeOut): string | null =>
  match(recipe.source)
    .with({ type: "book" }, (s) => s.book)
    .with({ type: "website" }, (s) => {
      try {
        return new URL(String(s.url)).host;
      } catch {
        return String(s.url);
      }
    })
    .otherwise(() => null);

const SourceCell: React.FC<{ recipe: RecipeOut }> = ({ recipe }) =>
  match(recipe.source)
    .with({ type: "book" }, (s) => {
      const label = (
        <>
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{s.book}</span>
        </>
      );
      return s.cookbookId ? (
        <Link
          to="/cookbooks/$cookbookId"
          params={{ cookbookId: s.cookbookId }}
          className="flex items-center gap-1 hover:underline"
        >
          {label}
        </Link>
      ) : (
        <span className="flex items-center gap-1">{label}</span>
      );
    })
    .with({ type: "website" }, (s) => (
      <a
        href={String(s.url)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 hover:underline"
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{sourceSubtitle(recipe)}</span>
      </a>
    ))
    .otherwise(() => <span className="text-muted-foreground">—</span>);

const STICKY = "sticky left-0 z-10 bg-card";

/** One grid row: sticky label, a cell per recipe, and the average cell. */
const GridRow: React.FC<{
  label: ReactNode;
  recipes: ComparedRecipe[];
  renderCell: (c: ComparedRecipe, index: number) => ReactNode;
  average: ReactNode;
}> = ({ label, recipes, renderCell, average }) => (
  <tr className="border-t">
    <td className={`${STICKY} px-3 py-2 align-top text-muted-foreground`}>
      {label}
    </td>
    {recipes.map((c, i) => (
      <td key={c.recipe.id} className="px-3 py-2 align-top">
        {renderCell(c, i)}
      </td>
    ))}
    <td className="border-primary/40 border-l-2 px-3 py-2 align-top text-primary">
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

  // Pre-compute per-recipe detail figures and their cross-recipe stats. Each
  // per-serving figure carries both range bounds; stats aggregate the midpoint
  // so a ranged recipe ($3–5) compares fairly against a flat one ($4.50).
  type Ranged = { lower: number; upper?: number };
  const costPerServing = (c: ComparedRecipe): Ranged | null => {
    const sb = getServingBasis(c.recipe);
    if (!sb || !c.headline) return null;
    return {
      lower: c.headline.cost / sb.divisor,
      upper:
        c.headline.costUpper != null
          ? c.headline.costUpper / sb.divisor
          : undefined,
    };
  };
  const caloriesPerServing = (c: ComparedRecipe): Ranged | null => {
    const sb = getServingBasis(c.recipe);
    if (!sb || !c.headline) return null;
    return {
      lower: c.headline.calories / sb.divisor,
      upper:
        c.headline.caloriesUpper != null
          ? c.headline.caloriesUpper / sb.divisor
          : undefined,
    };
  };
  const present = (xs: (number | null)[]): number[] =>
    xs.filter((x): x is number => x != null);
  const midOf = (r: Ranged | null): number | null =>
    r ? rangeMidpoint(r.lower, r.upper) : null;

  const costStats = computeStats(
    present(
      compared.map((c) =>
        c.headline
          ? rangeMidpoint(c.headline.cost, c.headline.costUpper)
          : null,
      ),
    ),
  );
  const costPerServingStats = computeStats(
    present(compared.map((c) => midOf(costPerServing(c)))),
  );
  const caloriesStats = computeStats(
    present(
      compared.map((c) =>
        c.headline
          ? rangeMidpoint(c.headline.calories, c.headline.caloriesUpper)
          : null,
      ),
    ),
  );
  const caloriesPerServingStats = computeStats(
    present(compared.map((c) => midOf(caloriesPerServing(c)))),
  );
  const proteinStats = computeStats(
    present(
      compared.map((c) =>
        c.headline
          ? rangeMidpoint(c.headline.protein, c.headline.proteinUpper)
          : null,
      ),
    ),
  );

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2.5">
        <div className="inline-flex rounded-md border p-0.5 text-sm">
          {(["gram", "baker"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBasisOverride(b)}
              className={`rounded px-3 py-1 transition-colors ${
                basis === b
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {b === "gram" ? "Grams" : "Baker's %"}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: "var(--primary)" }}
          />
          largest deviation from average
        </span>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={`${STICKY} z-20 w-32 px-3 pt-3 pb-2`} />
            {compared.map((c) => {
              const subtitle = sourceSubtitle(c.recipe);
              const hero = c.recipe.images[0]?.url;
              return (
                <th
                  key={c.recipe.id}
                  className="min-w-[120px] px-3 pt-3 pb-2 text-left align-top font-normal"
                >
                  <div className="relative mb-1.5">
                    {hero ? (
                      <img
                        src={hero}
                        alt={c.recipe.name}
                        className="h-10 w-full rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-full items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <ChefHat className="h-4 w-4" />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemove(c.recipe.id)}
                      className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/70 text-muted-foreground hover:text-destructive"
                      title="Remove from comparison"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <Link
                    to="/recipes/$id"
                    params={{ id: c.recipe.id }}
                    className="line-clamp-2 min-h-[2.5em] font-medium leading-tight hover:underline"
                  >
                    {c.recipe.name}
                  </Link>
                  {subtitle && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {subtitle}
                    </div>
                  )}
                </th>
              );
            })}
            <th className="min-w-[110px] border-primary/40 border-l-2 px-3 pt-3 pb-2 text-left align-top font-normal">
              <div className="mb-1.5 flex h-10 w-full items-center justify-center rounded-md bg-primary/10 text-primary">
                <Equal className="h-4 w-4" />
              </div>
              <div className="min-h-[2.5em] font-medium text-primary leading-tight">
                Average
              </div>
              <div className="text-[11px] text-muted-foreground">
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
              className={`${STICKY} px-3 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide`}
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
              c.headline
                ? formatCurrencyRange(c.headline.cost, c.headline.costUpper)
                : DASH
            }
            average={<AverageCell stats={costStats} format={currencyFormat} />}
          />
          <GridRow
            label="Cost / serving"
            recipes={compared}
            renderCell={(c) => {
              const cps = costPerServing(c);
              const sb = getServingBasis(c.recipe);
              return cps != null && sb ? (
                <span>
                  {formatCurrencyRange(cps.lower, cps.upper)}{" "}
                  <span className="text-muted-foreground text-xs">
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
              c.headline
                ? `${formatNumberRange(c.headline.calories, c.headline.caloriesUpper, (n) => `${Math.round(n)}`)} kcal`
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
              const cps = caloriesPerServing(c);
              return cps != null
                ? `${formatNumberRange(cps.lower, cps.upper, (n) => `${Math.round(n)}`)} kcal`
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
              c.headline
                ? `${formatNumberRange(c.headline.protein, c.headline.proteinUpper, (n) => `${Math.round(n)}`)}g`
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
            label="Costed"
            recipes={compared}
            renderCell={(c) => {
              if (!c.costing) return DASH;
              const total = c.costing.totals.totalIngredients;
              const covered =
                total - c.costing.totals.missingByType.price.length;
              return (
                <span className="text-muted-foreground text-xs">
                  {covered}/{total}
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
                  className="text-muted-foreground text-xs leading-snug"
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
