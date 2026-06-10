import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { KEY_NUTRIENTS } from "~/app/_components/units/NutrientsSummary";
import {
  EntitySummaryCard,
  type RecipeSummaryData,
} from "~/components/entity/entity-summary-card";
import {
  applyAbsorbedOil,
  type CalculateTotalsResult,
  calculateTotals,
  computeBakerPercentages,
  createIngredientData,
  type IngredientDataItem,
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
import { getIngredientName, isFlourIngredient } from "./recipe-utils";

// Small muted marker so estimated (absorbed frying-oil) values don't read as
// measured ones.
const EstimateMarker = () => (
  <span className="ml-1 text-2xs text-muted-foreground/70">est.</span>
);

export const RecipeIngredientList: React.FC<{
  ingredients: SectionIngredientOut[];
  ingMap: Record<string, IngredientWithFoodOut> | undefined;
  // Sub-recipe graphs, so recipe-as-ingredient rows + the summary roll up their
  // own cost/calories (scaled by amount/yield) instead of showing as missing.
  recipeMap?: Record<string, RecipeOut>;
}> = ({ ingredients, ingMap, recipeMap }) => {
  // Load ingredient data
  const data = useMemo(
    () => (ingMap ? createIngredientData(ingredients, ingMap, recipeMap) : []),
    [ingredients, ingMap, recipeMap],
  );

  // Load totals
  const totals = useMemo(
    () =>
      ingMap
        ? calculateTotals(ingredients, ingMap, getIngredientName, recipeMap)
        : undefined,
    [ingredients, ingMap, recipeMap],
  );

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

  // Baker's percentage per row: ingredient grams as a % of total flour grams.
  // Computed from the original data so the (unmeasured) oil row stays at "—".
  const bakerPct = useMemo(
    () => computeBakerPercentages(data, getIngredientName, isFlourIngredient),
    [data],
  );

  // Override unmeasured frying-medium rows' priceInfo with the absorbed-oil
  // estimate so the Cost/Weight/Nutrition columns render it instead of "—";
  // `oilRowIds` drives the "est." markers.
  const { data: displayData, oilRowIds } = useMemo(
    () =>
      ingMap
        ? applyAbsorbedOil(data, ingMap, getIngredientName)
        : { data, oilRowIds: new Set<string>() },
    [data, ingMap],
  );

  const columnHelper = createColumnHelper<IngredientDataItem>();

  const columns = [
    columnHelper.accessor((ingredient) => getIngredientName(ingredient), {
      id: "ing name",
      header: "Ingredient",
      enableSorting: false,
      meta: { className: "min-w-0 truncate" },
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

        // Unmeasured frying-medium rows have no amount; flag the estimate here so
        // the derived weight/calorie values read as guesses, not measurements.
        if (amounts.length === 0 && oilRowIds.has(info.row.original.id)) {
          return (
            <span className="text-muted-foreground text-sm">
              absorbed
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
              {oilRowIds.has(info.row.original.id) && measure.isOk() && (
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
              {oilRowIds.has(info.row.original.id) && measure.isOk() && (
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
          return <span className="text-muted-foreground">—</span>;
        }
        // One decimal below 10% so small-but-meaningful amounts (salt, leavening,
        // spices) don't collapse to a misleading "0%"; whole percent above.
        const label = `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
        // Mark the flour base (the 100% reference) so the column reads at a glance.
        return isFlourIngredient(getIngredientName(row)) ? (
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
        return <UnitMappingDisplay mappings={mappings} title="" compact />;
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
        isLoading={data.length === 0}
        error={undefined}
        ariaLabel="Recipe Ingredients Table"
      />
    </div>
  );
};
