import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import { mapValues } from "es-toolkit";
import { useMemo, useState } from "react";
import { match } from "ts-pattern";

import { KEY_NUTRIENTS } from "~/app/_components/units/NutrientsSummary";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import type {
  CalculateTotalsResult,
  CostingRow,
  IngredientDataItem,
  IngredientUsage,
  RecipeCosting,
} from "~/lib/recipe-costing";
import type { RecipeTotalsGap } from "~/lib/recipe-totals-gaps";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { cn } from "~/lib/utils";
import { renderValueOrMissing } from "~/misc/result";

import { createActionsColumnBase } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "../data-table/table-features";
import { useCubbyTableLayout } from "../data-table/table-layout";
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
import { getIngredientName, type ServingBasis } from "./recipe-utils";
import { MissingMeasureCell } from "./RecipeCostingCoverage";

// What an unmeasured estimated row shows in its Amounts cell, per usage.
// "absorbed" keeps its established meaning for frying oil; the rest read as
// what the estimate stands in for.
const ESTIMATE_AMOUNT_LABELS: Partial<Record<IngredientUsage, string>> = {
  frying_medium: "absorbed",
  seasoning: "to taste",
  pan_grease: "for the pan",
  garnish: "garnish",
  dredging: "coating",
};

// Stable empties for the loading state (referenced by cell renderers).
const EMPTY_ESTIMATED = new Map<string, IngredientUsage>();

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
  /** Per-portion basis (from the scaled recipe); drives the per-serving sub-lines. */
  perServing?: ServingBasis | null;
  /** Suppress the built-in Recipe Summary card (the Data view renders it once,
   * above the stacked charts, so the table shouldn't repeat it). */
  hideSummary?: boolean;
  /** The prioritized totals gaps (same source as the coverage popover) — makes
   * each missing Cost/Weight cell a deep-link to its fix. */
  gaps?: RecipeTotalsGap[];
  /** Current recipe's public id, for routing a sub-recipe's "set amount" fix. */
  recipeShortcode?: string;
}> = ({
  ingredients,
  ingMap,
  costing,
  perServing,
  hideSummary,
  gaps,
  recipeShortcode,
}) => {
  const totals = costing?.totals;
  const estimatedRows = costing?.estimatedRows ?? EMPTY_ESTIMATED;

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
        scalingPct: scalingPct.get(r.id) ?? null,
        isScalingBase: r.id === baseId,
      })),
    [costing, scalingPct, baseId],
  );

  // Load unit mappings
  const mappingsMap = useMemo(() => {
    if (!ingMap) return {};
    return mapValues(ingMap, (entry) =>
      (entry.product ?? []).flatMap((p) => getAllUnitMappingsFromProduct(p)),
    );
  }, [ingMap]);

  const columnHelper = createCubbyColumnHelper<ScalingRow>();

  const columns: CubbyColumnDef<ScalingRow>[] = [
    columnHelper.accessor((ingredient) => getIngredientName(ingredient), {
      id: "ing name",
      header: "Ingredient",
      enableSorting: false,
      // Fixed width (like the sibling numeric columns, which use w-*) so the
      // primary column doesn't collapse to "jala…"; the inner divs truncate
      // long names. `min-w-*` alone isn't honored by this table's layout.
      // Kept at w-48 (the overflow trim came from the numeric/pill columns,
      // which had slack — not from the name column, which is truncation-prone).
      meta: { className: "w-48" },
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
    columnHelper.accessor("amounts", {
      header: "Amounts",
      enableSorting: false,
      meta: { numeric: true, className: "w-28" },
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
              // biome-ignore lint/suspicious/noArrayIndexKey: amounts are positional without stable IDs
              <div key={index}>{tryFormatAmount(amount)}</div>
            ))}
          </Stack>
        );
      },
    }),
    // Numeric columns are accessors (not display) so the sort key is the raw
    // number; the cell still renders the rich Result-aware view. Missing values
    // sink to the bottom in both directions via sortUndefined: "last".
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
              {formatCurrencyRange(totals.price, totals.priceUpper)}
            </div>
          ) : null,
        cell: (info) => {
          const row = info.row.original;
          const measure = row.priceInfo?.price;
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
    columnHelper.accessor(
      (row) =>
        row.priceInfo?.gram.isOk() ? row.priceInfo.gram.value.value : undefined,
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
    // One mini-column per key nutrient — the table has room and per-nutrient
    // columns let you scan a single value (e.g. Protein) down the list.
    ...KEY_NUTRIENTS.map((n) =>
      columnHelper.accessor(
        (row) => {
          const res = row.priceInfo?.nutrient;
          if (!res || res.isErr()) return undefined;
          const value = res.value[n.code];
          return value != null && value > 0 ? value : undefined;
        },
        {
          id: `nutrient-${n.code}`,
          header: () => (
            <div className="flex flex-col leading-tight">
              <span>{n.label}</span>
              <span className="text-2xs font-normal text-muted-foreground lowercase">
                {n.unit}
              </span>
            </div>
          ),
          meta: { numeric: true, className: "w-14" },
          sortUndefined: "last",
          footer: () => {
            if (!totals) return null;
            const value = totals.nutrients[n.code];
            if (value == null || value <= 0) {
              return (
                <div className="text-right text-muted-foreground/40">·</div>
              );
            }
            const fmt = (v: number) =>
              n.unit === "g" ? v.toFixed(1) : Math.round(v).toString();
            return (
              <div className="text-right font-mono tabular-nums">
                {formatNumberRange(value, totals.nutrientsUpper?.[n.code], fmt)}
              </div>
            );
          },
          cell: (info) => {
            const nutrientResult = info.row.original.priceInfo?.nutrient;
            if (!nutrientResult) return null;
            return renderValueOrMissing(nutrientResult, (nutrients) => {
              const value = nutrients[n.code];
              if (value == null || value <= 0) {
                return <span className="text-muted-foreground/40">·</span>;
              }
              // Whole numbers for kcal/mg; one decimal for grams.
              return n.unit === "g"
                ? value.toFixed(1)
                : Math.round(value).toString();
            });
          },
        },
      ),
    ),
    columnHelper.display({
      id: "mappings",
      header: "Unit Mappings",
      meta: { className: "w-36" },
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
  ];

  const layout = useCubbyTableLayout({
    key: "recipe:ingredients",
    columns,
    legacySizingKey: "recipe:ingredients",
  });
  const table = useCubbyTable({
    data: displayData,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    enableFilters: false,
    getRowId: getScalingRowId,
    rowCount: ingredients.length,
    state: {
      pagination: {
        pageSize: ingredients.length,
        pageIndex: 0,
      },
    },
  });

  // Convert totals to RecipeSummaryData format
  const getRecipeSummaryData = (
    t: CalculateTotalsResult,
  ): RecipeSummaryData => ({
    price: t.price,
    ...(t.priceUpper != null ? { priceUpper: t.priceUpper } : {}),
    weight: t.weight,
    ...(t.weightUpper != null ? { weightUpper: t.weightUpper } : {}),
    nutrients: t.nutrients,
    ...(t.nutrientsUpper ? { nutrientsUpper: t.nutrientsUpper } : {}),
    totalIngredients: t.totalIngredients,
    missingByType: t.missingByType,
    perServing,
  });

  return (
    <div>
      {!hideSummary && totals && (
        <EntitySummaryCard
          title="Recipe Summary"
          summaryData={{
            type: "recipe",
            data: getRecipeSummaryData(totals),
          }}
        />
      )}
      <RTable
        table={table}
        isLoading={displayData.length === 0}
        error={undefined}
        ariaLabel="Recipe Ingredients Table"
        verticalAlign="top"
        embedded
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
