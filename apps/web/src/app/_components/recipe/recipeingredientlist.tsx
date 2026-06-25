import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { mapValues } from "es-toolkit";
import { useMemo, useState } from "react";
import { match } from "ts-pattern";
import { NoneState } from "~/app/_components/NoneState";
import { KEY_NUTRIENTS } from "~/app/_components/units/NutrientsSummary";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import type {
  CalculateTotalsResult,
  CostingRow,
  IngredientDataItem,
  IngredientUsage,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { cn } from "~/lib/utils";
import { renderValueOrMissing } from "~/misc/result";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { createActionsColumnBase } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import { EntityPillLink } from "../EntityPill";
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

export const RecipeIngredientList: React.FC<{
  ingredients: CostingRow[];
  ingMap: Record<string, IngredientWithFoodOut> | undefined;
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
}> = ({ ingredients, ingMap, costing, perServing }) => {
  const totals = costing?.totals;
  const estimatedRows = costing?.estimatedRows ?? EMPTY_ESTIMATED;

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

  const columnHelper = createColumnHelper<ScalingRow>();

  const columns = [
    columnHelper.accessor((ingredient) => getIngredientName(ingredient), {
      id: "ing name",
      header: "Ingredient",
      enableSorting: false,
      // Fixed width (like the sibling numeric columns, which use w-*) so the
      // primary column doesn't collapse to "jala…"; the inner divs truncate
      // long names. `min-w-*` alone isn't honored by this table's layout.
      meta: { className: "w-48" },
      cell: (info) => {
        const row = info.row.original;
        const rawLine = row.rawLine;
        const name = info.getValue();
        return (
          <div className="min-w-0">
            <div className="truncate">
              {name}
              <IngredientModifier modifier={row.modifier} />
            </div>
            {rawLine && rawLine !== name && (
              <div
                className="truncate text-muted-foreground/70 text-xs italic"
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
      meta: { className: "w-32" },
      cell: (info) => {
        const amounts = info.getValue();

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
        meta: { className: "w-24" },
        sortUndefined: "last",
        cell: (info) => {
          const measure = info.row.original.priceInfo?.price;
          if (!measure) return null;
          return (
            <span>
              {renderValueOrMissing(measure, (m) => tryFormatAmount(m))}
              {estimatedRows.has(info.row.original.id) && measure.isOk() && (
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
        meta: { className: "w-24" },
        sortUndefined: "last",
        cell: (info) => {
          const measure = info.row.original.priceInfo?.gram;
          if (!measure) return null;
          return (
            <span>
              {renderValueOrMissing(measure, (m) => tryFormatAmount(m))}
              {estimatedRows.has(info.row.original.id) && measure.isOk() && (
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
      meta: { className: "w-20" },
      sortUndefined: "last",
      cell: (props) => {
        const row = props.row.original;
        const pct = row.scalingPct;
        if (pct == null) {
          return <NoneState />;
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
              <span className="font-normal text-2xs text-muted-foreground/70 lowercase">
                {n.unit}
              </span>
            </div>
          ),
          meta: { className: "w-14 text-right tabular-nums" },
          sortUndefined: "last",
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
      id: "ingredientDetails",
      header: "Ingredient Details",
      meta: { className: "w-40" },
      cell: (props) =>
        match(props.row.original)
          .with({ type: "ingredient" }, (row) => (
            <EntityPillLink
              entity="ingredient"
              data={{
                name: row.ingredient.name,
                id: row.ingredient.id,
              }}
              compact
            />
          ))
          .with({ type: "recipe" }, (row) => (
            <EntityPillLink entity="recipe" data={row.recipe} compact />
          ))
          .exhaustive(),
    }),
    columnHelper.display({
      id: "mappings",
      header: "Unit Mappings",
      meta: { className: "w-40" },
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
          />
        );
      },
    }),
    // Actions column - links to ingredient or recipe detail
    createActionsColumnBase(columnHelper, (row) =>
      match(row)
        .with({ type: "ingredient" }, (row) => ({
          to: "/ingredients/$id" as const,
          params: { id: row.ingredient.id },
        }))
        .with({ type: "recipe" }, (row) => ({
          to: "/recipes/$id" as const,
          params: { id: row.recipe.id },
        }))
        .exhaustive(),
    ),
  ];

  const table = useReactTable({
    data: displayData,
    columns,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
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
      {totals && (
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
