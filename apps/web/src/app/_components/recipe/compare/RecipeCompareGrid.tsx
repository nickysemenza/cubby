import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import { BookOpen, ChefHat, Equal, ExternalLink, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { match } from "ts-pattern";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import { formatCurrency } from "~/lib/utils";
import {
  formatYield,
  getServingBasis,
  isFlourIngredient,
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
import { DeviationBar } from "./DeviationBar";

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
        isFlour: isFlourIngredient(name),
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
  return (
    <div className="space-y-0.5">
      <div className="font-medium">{format.mean(stats.mean)}</div>
      {stats.count >= 2 && stats.max > stats.min && (
        <div className="text-[11px] text-muted-foreground leading-tight">
          <div>
            {format.num(stats.min)}–{format.num(stats.max)}
          </div>
          <div>
            σ{format.num(stats.std)}
            {stats.cv != null && ` · cv ${Math.round(stats.cv)}%`}
          </div>
        </div>
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

  // Pre-compute per-recipe detail figures and their cross-recipe stats.
  const costPerServing = (c: ComparedRecipe): number | null => {
    const sb = getServingBasis(c.recipe);
    return sb && c.headline ? c.headline.cost / sb.divisor : null;
  };
  const caloriesPerServing = (c: ComparedRecipe): number | null => {
    const sb = getServingBasis(c.recipe);
    return sb && c.headline ? c.headline.calories / sb.divisor : null;
  };
  const present = (xs: (number | null)[]): number[] =>
    xs.filter((x): x is number => x != null);

  const costStats = computeStats(
    present(compared.map((c) => c.headline?.cost ?? null)),
  );
  const costPerServingStats = computeStats(
    present(compared.map(costPerServing)),
  );
  const caloriesStats = computeStats(
    present(compared.map((c) => c.headline?.calories ?? null)),
  );
  const caloriesPerServingStats = computeStats(
    present(compared.map(caloriesPerServing)),
  );
  const proteinStats = computeStats(
    present(compared.map((c) => c.headline?.protein ?? null)),
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
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: "var(--warning)" }}
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
                  className="min-w-[150px] px-3 pt-3 pb-2 text-left align-bottom font-normal"
                >
                  {hero ? (
                    <img
                      src={hero}
                      alt={c.recipe.name}
                      className="mb-2 h-14 w-full rounded-md object-cover"
                    />
                  ) : (
                    <div className="mb-2 flex h-14 w-full items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <ChefHat className="h-5 w-5" />
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-1">
                    <Link
                      to="/recipes/$id"
                      params={{ id: c.recipe.id }}
                      className="font-medium leading-tight hover:underline"
                    >
                      {c.recipe.name}
                    </Link>
                    <button
                      type="button"
                      onClick={() => onRemove(c.recipe.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title="Remove from comparison"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {subtitle && (
                    <div className="truncate text-muted-foreground text-xs">
                      {subtitle}
                    </div>
                  )}
                </th>
              );
            })}
            <th className="min-w-[120px] border-primary/40 border-l-2 px-3 pt-3 pb-2 text-left align-bottom font-normal">
              <div className="mb-2 flex h-14 w-full items-center justify-center rounded-md bg-primary/10 text-primary">
                <Equal className="h-5 w-5" />
              </div>
              <div className="font-medium text-primary leading-tight">
                Average
              </div>
              <div className="text-muted-foreground text-xs">
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
                      className={
                        isMax
                          ? "font-medium"
                          : isZero
                            ? "text-muted-foreground/50"
                            : undefined
                      }
                      style={isMax ? { color: "var(--warning)" } : undefined}
                    >
                      {formatValue(v, basis)}
                    </span>
                    {row.maxDeviationIndex != null && row.average != null && (
                      <DeviationBar
                        value={v}
                        average={row.average}
                        maxAbsDeviation={row.maxAbsDeviation}
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
              c.headline ? formatCurrency(c.headline.cost) : DASH
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
                  {formatCurrency(cps)}{" "}
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
              c.headline ? `${Math.round(c.headline.calories)} kcal` : DASH
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
              return cps != null ? `${Math.round(cps)} kcal` : DASH;
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
              c.headline ? `${Math.round(c.headline.protein)}g` : DASH
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
