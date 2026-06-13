import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { NoneState } from "~/app/_components/NoneState";
import { KEY_NUTRIENTS } from "~/app/_components/units/NutrientsSummary";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import type {
  CalculateTotalsResult,
  CostingRow,
  IngredientDataItem,
  IngredientUsage,
  RecipeCosting,
} from "~/lib/recipe-costing";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { renderValueOrMissing } from "~/misc/result";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { createActionsColumnBase } from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import { EntityPillLink } from "../EntityPill";
import { tryFormatAmount } from "../inventory/format-amount";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { CopyCorpusButton } from "./copy-corpus-button";
import { EstimateMarker } from "./estimate-marker";
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
const EMPTY_BAKER = new Map<string, number | null>();

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
  const displayData = costing?.rows ?? [];
  const totals = costing?.totals;
  const estimatedRows = costing?.estimatedRows ?? EMPTY_ESTIMATED;
  const bakerPct = costing?.bakerPct ?? EMPTY_BAKER;

  // Load unit mappings
  const mappingsMap = useMemo(() => {
    if (!ingMap) return {};
    const entries = Object.entries(ingMap).map(([id, entry]) => {
      const productMappings = (entry.product ?? []).flatMap((p) =>
        getAllUnitMappingsFromProduct(p),
      );
      return [id, productMappings] as const;
    });
    return Object.fromEntries(entries);
  }, [ingMap]);

  const columnHelper = createColumnHelper<IngredientDataItem>();

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
            <div className="truncate">{name}</div>
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
            <span className="text-muted-foreground text-sm">
              {ESTIMATE_AMOUNT_LABELS[usage] ?? "estimated"}
              <EstimateMarker />
            </span>
          );
        }

        // Format each amount using tryFormatAmount
        return (
          <div className="space-y-0.5 text-sm">
            {amounts.map((amount, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: amounts are positional without stable IDs
              <div key={index}>{tryFormatAmount(amount)}</div>
            ))}
          </div>
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
    columnHelper.accessor((row) => bakerPct.get(row.id) ?? undefined, {
      id: "bakerPct",
      header: "Baker's %",
      meta: { className: "w-20" },
      sortUndefined: "last",
      cell: (props) => {
        const row = props.row.original;
        const pct = bakerPct.get(row.id);
        if (pct == null) {
          return <NoneState />;
        }
        // One decimal below 10% so small-but-meaningful amounts (salt, leavening,
        // spices) don't collapse to a misleading "0%"; whole percent above.
        const label = `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
        // Mark the flour base (the 100% reference) so the column reads at a glance.
        return (costing?.isFlourRows.get(row.id) ?? false) ? (
          <span className="font-semibold text-primary">{label}</span>
        ) : (
          label
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
      cell: (props) => {
        const row = props.row.original;

        if (row.type === "ingredient") {
          return (
            <EntityPillLink
              entity="ingredient"
              data={{
                name: row.ingredient.name,
                id: row.ingredient.id,
              }}
              compact
            />
          );
        } else if (row.type === "recipe") {
          return <EntityPillLink entity="recipe" data={row.recipe} compact />;
        }

        return null;
      },
    }),
    columnHelper.display({
      id: "mappings",
      header: "Unit Mappings",
      meta: { className: "w-40" },
      cell: (props) => {
        if (ingMap === undefined) {
          return "loading";
        }

        const row = props.row.original;
        let id: string | undefined;

        if (row.type === "ingredient") {
          id = row.ingredient.id;
        }

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
    createActionsColumnBase(columnHelper, (row) => {
      if (row.type === "ingredient") {
        return { to: "/ingredients/$id", params: { id: row.ingredient.id } };
      }
      if (row.type === "recipe") {
        return { to: "/recipes/$id", params: { id: row.recipe.id } };
      }
      return null;
    }),
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
    weight: t.weight,
    nutrients: t.nutrients,
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
