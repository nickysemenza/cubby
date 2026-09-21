import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import { hasKnownEstimate, nutrientKey } from "@cubby/schemas/nutrition";
import {
  TIER1_NUTRIENT_KEYS,
  TIER1_NUTRIENTS,
  KEY_NUTRIENT_KEYS,
  type NutrientKey,
} from "@cubby/usda-schemas";
import { Link } from "@tanstack/react-router";
import { mapValues } from "es-toolkit";
import { useMemo, useState } from "react";
import { match } from "ts-pattern";

import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { useHydrationGate } from "~/hooks/useHydrated";
import { formatNumberRange } from "~/lib/format-range";
import { scaleNutrition } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";
import type {
  CostingRow,
  IngredientDataItem,
  IngredientUsage,
  RecipeCosting,
} from "~/lib/recipe-costing";
import type { RecipeTotalsGap } from "~/lib/recipe-totals-gaps";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { cn, formatCurrency } from "~/lib/utils";

import { useTableColumnLayout } from "../data-table/column-layout";
import { createActionsColumnBase } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "../data-table/table-features";
import { dottedEntityLink, EntityPreviewLink } from "../EntityPreviewLink";
import { tryFormatAmount } from "../inventory/format-amount";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { CopyCorpusButton } from "./copy-corpus-button";
import { EstimateMarker } from "./estimate-marker";
import { IngredientModifier } from "./IngredientQuantities";
import {
  computeScalingPercentages,
  formatScalingPct,
  pickDefaultBaseRowId,
} from "./recipe-scaling-pct";
import { getIngredientName } from "./recipe-utils";
import { MissingMeasureCell } from "./RecipeCostingCoverage";

// What an unmeasured estimated row shows in its Amounts cell, per usage.
// "absorbed" keeps its established meaning for frying oil; the rest read as
// what the estimate stands in for.
const ESTIMATE_AMOUNT_LABELS = {
  normal: undefined,
  frying_medium: "absorbed",
  seasoning: "to taste",
  pan_grease: "for the pan",
  garnish: "garnish",
  dredging: "coating",
  marinade: undefined,
} satisfies Record<IngredientUsage, string | undefined>;

// Stable empties for the loading state (referenced by cell renderers).
const EMPTY_ESTIMATED = new Map<string, IngredientUsage>();
const DEFAULT_NUTRIENT_KEYS = new Set([
  "kcal",
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sodium",
]);

// The row data with the re-anchorable scaling % + base flag baked in. RTable
// memoizes rows and only re-renders them when `row.original` changes, so a cell
// that reads the base from closure would never update on a re-anchor click —
// carrying it in the row identity is what makes clicking a % re-scale the column.
type ScalingRow = IngredientDataItem & {
  scalingPct: number | null;
  isScalingBase: boolean;
};

const getScalingRowId = (row: ScalingRow) => row.id;

export const RecipeIngredientList: React.FC<{
  ingredients: CostingRow[];
  ingMap: Record<string, IngredientWithFoodLeanOut> | undefined;
  /**
   * The unified engine result (computed by the parent — RecipeDetail — with
   * sub-recipe rollups, usage estimates, and baker percentages applied). Rows
   * already carry the consumption-model-adjusted measures, so the Cost/Weight/
   * Nutrition columns render estimates instead of "—" (or, for measured fry
   * oil, instead of the whole pot); `estimatedRows` drives the "est." markers.
   * Baker % is own-gram based, so the (unmeasured) oil row stays at "—".
   */
  costing: RecipeCosting | null;
  /** The prioritized totals gaps (same source as the coverage popover) — makes
   * each missing Cost/Weight cell a deep-link to its fix. */
  gaps?: RecipeTotalsGap[];
  /** Current recipe's public id, for routing a sub-recipe's "set amount" fix. */
  recipeShortcode?: string;
  /** Nutrition-only basis projection; recipe amounts/cost stay at recipe scale. */
  nutritionFactor?: number;
}> = ({
  ingredients,
  ingMap,
  costing,
  gaps,
  recipeShortcode,
  nutritionFactor = 1,
}) => {
  const totals = costing?.totals;
  const estimatedRows = costing?.estimatedRows ?? EMPTY_ESTIMATED;
  const [focusedNutrient, setFocusedNutrient] =
    useState<(typeof TIER1_NUTRIENT_KEYS)[number]>("kcal");

  // Index gaps for O(1) per-cell lookup: ingredient rows key on ingredientId,
  // sub-recipe rows key on the section-ingredient rowId (row.id).
  const gapByKey = useMemo(() => {
    const m = new Map<string, RecipeTotalsGap>();
    for (const gap of gaps ?? []) {
      m.set(gap.source === "ingredient" ? gap.ingredientId : gap.rowId, gap);
    }
    return m;
  }, [gaps]);
  const gapForRow = (row: CostingRow): RecipeTotalsGap | undefined =>
    match(row)
      .with({ type: "ingredient" }, (r) => gapByKey.get(r.ingredient.id))
      .with({ type: "recipe" }, (r) => gapByKey.get(r.id))
      .exhaustive();
  const renderNutrient = (row: ScalingRow, key: NutrientKey) => {
    const estimate = row.nutrition[key];
    const nutrient = TIER1_NUTRIENTS[key];
    if (estimate.status !== "unavailable")
      return formatEstimate(
        estimate,
        (value) => `${Number(value.toFixed(1))} ${nutrient.unit.toLowerCase()}`,
      );
    const label = `Repair ${nutrient.displayName.toLowerCase()} data for ${getIngredientName(row)}`;
    return row.type === "ingredient" ? (
      <Link
        to="/ingredients/workbench"
        search={{ focus: row.ingredient.id }}
        aria-label={label}
        title={label}
        className="text-warning-ink underline decoration-dotted underline-offset-2"
      >
        —
      </Link>
    ) : (
      <Link
        to="/recipes/$shortcode"
        params={{ shortcode: row.recipe.id }}
        search={{ view: "data" }}
        aria-label={label}
        title={label}
        className="text-warning-ink underline decoration-dotted underline-offset-2"
      >
        —
      </Link>
    );
  };

  // Scaling % (Modernist Cuisine's column): baker's percentage with a
  // re-anchorable 100% base instead of flour-only — the same single scaling
  // system the Spec view uses. Defaults to flour/heaviest; clicking a row's %
  // re-anchors it, recomputed client-side from resolved grams (no WASM call).
  const [pickedBaseId, setPickedBaseId] = useState<string | null>(null);
  const defaultBaseId = useMemo(
    () => (costing ? pickDefaultBaseRowId(costing) : null),
    [costing],
  );
  const baseId = pickedBaseId ?? defaultBaseId;
  const scalingPct = useMemo(
    () =>
      costing
        ? computeScalingPercentages(costing, baseId)
        : new Map<string, number | null>(),
    [costing, baseId],
  );

  // Bake the scaling % + base flag into each row so re-anchoring (which doesn't
  // touch the engine rows) still changes `row.original` and re-renders the
  // memoized RTable rows. Identity changes only when the base/costing change, so
  // unrelated parent re-renders still skip the rows.
  const displayData: ScalingRow[] = useMemo(
    () =>
      (costing?.rows ?? []).map((r) => ({
        ...r,
        nutrition: scaleNutrition(r.nutrition, nutritionFactor),
        scalingPct: scalingPct.get(r.id) ?? null,
        isScalingBase: r.id === baseId,
      })),
    [costing, scalingPct, baseId, nutritionFactor],
  );
  const displayedNutrition = useMemo(
    () =>
      totals
        ? scaleNutrition(totals.estimates.nutrition, nutritionFactor)
        : null,
    [totals, nutritionFactor],
  );

  // Load unit mappings
  const mappingsMap = useMemo(() => {
    if (!ingMap) return {};
    return mapValues(ingMap, (entry) =>
      (entry.product ?? []).flatMap((p) => getAllUnitMappingsFromProduct(p)),
    );
  }, [ingMap]);

  const columnHelper = createCubbyColumnHelper<ScalingRow>();

  const columns = createCubbyColumnCollection<ScalingRow>((add) => {
    add(
      columnHelper.accessor((ingredient) => getIngredientName(ingredient), {
        id: "ing name",
        header: "Ingredient",
        enableSorting: false,
        minSize: 224,
        meta: { className: "w-60", mobile: { slot: "title" } },
        footer: () => <span className="font-semibold">Totals</span>,
        cell: (info) => {
          const row = info.row.original;
          const rawLine = row.rawLine;
          const name = info.getValue();
          return (
            <div className="min-w-0">
              <div className="truncate" title={name}>
                {match(row)
                  .with({ type: "ingredient" }, (r) => (
                    <EntityPreviewLink
                      displayImage={null}
                      entity="ingredient"
                      id={r.ingredient.id}
                      className={dottedEntityLink}
                    >
                      {name}
                    </EntityPreviewLink>
                  ))
                  .with({ type: "recipe" }, (r) => (
                    <EntityPreviewLink
                      displayImage={null}
                      entity="recipe"
                      id={r.recipe.id}
                      className={dottedEntityLink}
                    >
                      {name}
                    </EntityPreviewLink>
                  ))
                  .exhaustive()}
                <IngredientModifier modifier={row.modifier} />
              </div>
              {rawLine && rawLine !== name && (
                <div
                  className="truncate text-xs text-muted-foreground italic"
                  title={rawLine}
                >
                  {rawLine}
                </div>
              )}
              {rawLine && (
                <CopyCorpusButton
                  rawLine={rawLine}
                  name={name}
                  amounts={row.amounts}
                  modifier={row.modifier}
                />
              )}
            </div>
          );
        },
      }),
    );
    add(
      columnHelper.accessor("amounts", {
        header: "Amounts",
        enableSorting: false,
        meta: {
          numeric: true,
          className: "w-28",
          mobile: { slot: "subtitle" },
        },
        cell: (info) => {
          // The shared column array erases heterogeneous TValue to keep every
          // column interoperable; this accessor's value is still ScalingRow's
          // concrete amounts field.
          const amounts: ScalingRow["amounts"] = info.getValue();

          // Unmeasured estimated rows have no amount; flag the estimate here so
          // the derived weight/calorie values read as guesses, not measurements.
          const usage = estimatedRows.get(info.row.original.id);
          if (amounts.length === 0 && usage) {
            return (
              <Description as="span">
                {ESTIMATE_AMOUNT_LABELS[usage] ?? "estimated"}
                <EstimateMarker />
              </Description>
            );
          }

          // Format each amount using tryFormatAmount
          return (
            <Stack gap="xs" className="text-sm">
              {amounts.map((amount, index) => (
                <div
                  // oxlint-disable-next-line react/no-array-index-key -- Ingredient amounts are a positional display list without stable ids, and equal amounts are valid.
                  key={index}
                >
                  {tryFormatAmount(amount)}
                </div>
              ))}
            </Stack>
          );
        },
      }),
    );
    // Numeric columns are accessors (not display) so the sort key is the raw
    // number; the cell still renders the rich Result-aware view. Missing values
    // sink to the bottom in both directions via sortUndefined: "last".
    add(
      columnHelper.accessor(
        (row) =>
          row.priceInfo?.price.isOk()
            ? row.priceInfo.price.value.value
            : undefined,
        {
          id: "dollars",
          header: "Cost",
          meta: { numeric: true, className: "w-20" },
          sortUndefined: "last",
          footer: () =>
            totals ? (
              <div className="text-right font-mono tabular-nums">
                {formatEstimate(totals.estimates.cost, formatCurrency)}
              </div>
            ) : null,
          cell: (info) => {
            const row = info.row.original;
            const measure = row.priceInfo?.price;
            if (!measure) return null;
            return (
              <span>
                {measure.isOk() ? (
                  <>
                    {tryFormatAmount(measure.value)}
                    {row.totalsMissing.price ? " known · partial" : null}
                  </>
                ) : (
                  <MissingMeasureCell
                    gap={gapForRow(row)}
                    currentRecipeShortcode={recipeShortcode ?? ""}
                    reason={`${measure.error}`}
                  />
                )}
                {estimatedRows.has(row.id) && measure.isOk() && (
                  <EstimateMarker />
                )}
              </span>
            );
          },
        },
      ),
    );
    add(
      columnHelper.accessor(
        (row) =>
          row.priceInfo?.gram.isOk()
            ? row.priceInfo.gram.value.value
            : undefined,
        {
          id: "grams",
          header: "Weight",
          meta: { numeric: true, className: "w-20" },
          sortUndefined: "last",
          footer: () =>
            totals ? (
              <div className="text-right font-mono tabular-nums">
                {formatNumberRange(
                  totals.weight,
                  totals.weightUpper,
                  (g) => `${Math.round(g)} g`,
                )}
              </div>
            ) : null,
          cell: (info) => {
            const row = info.row.original;
            const measure = row.priceInfo?.gram;
            if (!measure) return null;
            return (
              <span>
                {measure.isOk() ? (
                  tryFormatAmount(measure.value)
                ) : (
                  <MissingMeasureCell
                    gap={gapForRow(row)}
                    currentRecipeShortcode={recipeShortcode ?? ""}
                    reason={`${measure.error}`}
                  />
                )}
                {estimatedRows.has(row.id) && measure.isOk() && (
                  <EstimateMarker />
                )}
              </span>
            );
          },
        },
      ),
    );
    add(
      columnHelper.accessor((row) => row.scalingPct ?? undefined, {
        id: "scalingPct",
        header: "Scaling %",
        meta: { numeric: true, className: "w-20" },
        sortUndefined: "last",
        cell: (props) => {
          const row = props.row.original;
          const pct = row.scalingPct;
          if (pct == null) {
            return <NoneValue />;
          }
          return (
            <button
              type="button"
              onClick={() => setPickedBaseId(row.id)}
              aria-pressed={row.isScalingBase}
              title="Set as 100% base"
              className={cn(
                "cursor-pointer tabular-nums hover:text-primary",
                row.isScalingBase && "font-semibold text-primary",
              )}
            >
              {formatScalingPct(pct)}
            </button>
          );
        },
      }),
    );
    for (const key of [
      ...KEY_NUTRIENT_KEYS,
      ...TIER1_NUTRIENT_KEYS.filter((key) => !DEFAULT_NUTRIENT_KEYS.has(key)),
    ]) {
      const nutrient = TIER1_NUTRIENTS[key];
      add(
        columnHelper.accessor(
          (row) => {
            const estimate = row.nutrition[key];
            return hasKnownEstimate(estimate) ? estimate.lower : undefined;
          },
          {
            id: `nutrient-${nutrient.code}`,
            header: `${nutrient.displayName} (${nutrient.unit.toLowerCase()})`,
            minSize: 144,
            meta: { numeric: true, className: "w-40" },
            sortUndefined: "last",
            footer: () =>
              displayedNutrition ? (
                <div className="text-right font-mono text-xs whitespace-normal tabular-nums">
                  {formatEstimate(
                    displayedNutrition[key],
                    (value) =>
                      `${Number(value.toFixed(1))} ${nutrient.unit.toLowerCase()}`,
                  )}
                </div>
              ) : null,
            cell: (info) => (
              <span className="text-xs whitespace-normal">
                {renderNutrient(info.row.original, key)}
              </span>
            ),
          },
        ),
      );
    }
    add(
      columnHelper.display({
        id: "mappings",
        header: "Unit Mappings",
        meta: {
          className: "w-36",
          mobile: { slot: "meta", interactive: true },
        },
        cell: (props) => {
          if (ingMap === undefined) {
            return "loading";
          }

          const id = match(props.row.original)
            .with({ type: "ingredient" }, (row) => row.ingredient.id)
            .with({ type: "recipe" }, () => undefined)
            .exhaustive();

          const mappings = id ? (mappingsMap[id] ?? []) : [];
          return (
            <UnitMappingDisplay
              mappings={mappings}
              title=""
              compact
              showCoverage
              showUnitPrice
            />
          );
        },
      }),
    );
    add(
      createActionsColumnBase(columnHelper, (row) =>
        match(row)
          .with({ type: "ingredient" }, (row) => ({
            to: "/ingredients/$shortcode" as const,
            params: { shortcode: row.ingredient.id },
          }))
          .with({ type: "recipe" }, (row) => ({
            to: "/recipes/$shortcode" as const,
            params: { shortcode: row.recipe.id },
          }))
          .exhaustive(),
      ),
    );
  });

  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
    initialColumnVisibility: {
      grams: false,
      scalingPct: false,
      mappings: false,
      ...Object.fromEntries(
        TIER1_NUTRIENT_KEYS.map((key) => [
          `nutrient-${TIER1_NUTRIENTS[key].code}`,
          DEFAULT_NUTRIENT_KEYS.has(key),
        ]),
      ),
    },
  });
  const [columnVisibility, setColumnVisibility] = useState(
    defaultLayout.columnVisibility,
  );
  const table = useCubbyTable({
    data: displayData,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
    },
    meta: { defaultLayout },
    enableFilters: false,
    getRowId: getScalingRowId,
    rowCount: ingredients.length,
    state: {
      columnVisibility,
      pagination: {
        pageSize: ingredients.length,
        pageIndex: 0,
      },
    },
    onColumnVisibilityChange: setColumnVisibility,
  });

  const nutrientSelectGate = useHydrationGate(undefined);
  const selectNutrient = (key: (typeof TIER1_NUTRIENT_KEYS)[number]) => {
    setFocusedNutrient(key);
    const id = `nutrient-${TIER1_NUTRIENTS[key].code}`;
    setColumnVisibility((current) => ({ ...current, [id]: true }));
  };

  return (
    <div>
      <section
        className="mb-4 border border-border p-3"
        aria-label="Nutrition contributions"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Nutrition contributions</h3>
            <p className="text-xs text-muted-foreground">
              Select a nutrient to reveal its column and ingredient
              contributions.
            </p>
          </div>
          <label className="text-xs font-medium">
            Focused nutrient{" "}
            <select
              aria-label="Focused nutrient"
              value={focusedNutrient}
              onChange={(event) =>
                selectNutrient(nutrientKey.parse(event.target.value))
              }
              className="ml-2 h-11 border border-border bg-background px-2 md:h-8"
              {...nutrientSelectGate}
            >
              {TIER1_NUTRIENT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {TIER1_NUTRIENTS[key].displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div
          className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
          data-testid="nutrition-contributions"
        >
          {displayData.map((row) => {
            const name = getIngredientName(row);
            return (
              <div
                key={row.id}
                className="flex items-center justify-between gap-3 border-t border-border/60 py-2"
              >
                <span className="min-w-0 truncate" title={name}>
                  {name}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {renderNutrient(row, focusedNutrient)}
                </span>
              </div>
            );
          })}
          {displayedNutrition ? (
            <div className="col-span-full flex justify-between gap-3 border-t border-foreground pt-2 font-semibold">
              <span>Known subtotal</span>
              <span className="font-mono text-xs">
                {formatEstimate(
                  displayedNutrition[focusedNutrient],
                  (value) =>
                    `${Number(value.toFixed(1))} ${TIER1_NUTRIENTS[focusedNutrient].unit.toLowerCase()}`,
                )}
              </span>
            </div>
          ) : null}
        </div>
      </section>
      <RTable
        table={table}
        isLoading={displayData.length === 0}
        error={undefined}
        ariaLabel="Recipe Ingredients Table"
        verticalAlign="top"
        embedded
        showColumnMenu
        getRowClassName={(row) =>
          // Wash estimated rows in a soft honey tint so usage-adjusted numbers
          // read as approximate at a glance, not just via the "est." markers.
          estimatedRows.has(row.original.id)
            ? "bg-[var(--chart-seq-2)]/25"
            : undefined
        }
      />
    </div>
  );
};
