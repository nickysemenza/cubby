import type {
  FoodSummaryWithLinkedProducts,
  USDAFoodSortField,
} from "@cubby/schemas/usda";
import {
  type DataType,
  dataTypeEnum,
  dataTypeLabel,
} from "@cubby/usda-schemas";
import { useCallback, useMemo } from "react";

import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { usdaFood } from "~/entities/usda.functions";
import { USDA_KINDS } from "~/lib/conversion-coverage";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { nutrientCount } from "~/lib/usda-food-stats";

import { createEntityInlineLinkColumn } from "../_components/data-table/columnHelpers";
import type { TableStateReturn } from "../_components/data-table/useTableState";
import type { ListQueryOptionsFn } from "../_components/hooks/usePaginatedTableCore";
import { TableLink } from "../_components/table/TableLink";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { CoreNutrientCoverage } from "../_components/usda/core-nutrient-coverage";

type USDAListRow = FoodSummaryWithLinkedProducts & {
  id: string;
  name: string;
};

type USDAListFilters = {
  nameFilter?: string;
  dataTypeFilter?: DataType;
  linkedProductsOnly?: boolean;
  foodsOnly: true;
};

const USDA_TABLE_STATE = { initialSort: "fdc_id" } as const;
const USDA_FILTERS = [
  { id: "description", placeholder: "Filter by description..." },
];

export interface USDAFoodListOperations {
  list: typeof usdaFood.list;
}

const productionOperations: USDAFoodListOperations = { list: usdaFood.list };

const buildUSDAFilters = (tableState: TableStateReturn): USDAListFilters => ({
  nameFilter: tableState.getColumnFilter("description"),
  dataTypeFilter: dataTypeEnum
    .optional()
    .parse(tableState.getColumnFilter("foodInfo-data_type")),
  linkedProductsOnly:
    tableState.getColumnFilter("linkedProducts") === "linked" || undefined,
  foodsOnly: true,
});

const USDA_SORT_FIELDS = new Map<string, USDAFoodSortField>([
  ["fdc_id", "fdc_id"],
  ["description", "description"],
  ["foodInfo-data_type", "data_type"],
  ["linkedProducts", "linkedProducts"],
]);

export const withUSDAListIdentity = <
  TFood extends { fdc_id: number; foodInfo: { description: string } },
>(
  food: TFood,
): TFood & { id: string; name: string } => ({
  ...food,
  id: String(food.fdc_id),
  name: food.foodInfo.description,
});

export function USDAFoodList({
  operations = productionOperations,
}: {
  operations?: USDAFoodListOperations;
}) {
  const queryOptions = useCallback<
    ListQueryOptionsFn<USDAListFilters, USDAListRow>
  >(
    (params) => {
      const searching = Boolean(params.filters.nameFilter);
      const requestedSorts = params.sort ?? [];
      const listParams = {
        filters: params.filters,
        pagination: params.pagination,
        sort: requestedSorts,
      };
      const input = operations.list.definition.input.parse({
        ...listParams,
        sort: searching
          ? [{ orderBy: "relevance", direction: "asc" }]
          : requestedSorts.map((sort) => ({
              ...sort,
              orderBy: USDA_SORT_FIELDS.get(sort.orderBy) ?? "fdc_id",
            })),
      });
      const policy = operations.list.policy(input);
      return {
        queryKey: operations.list.queryKey(input),
        meta: policy.meta,
        execute: async (signal) => {
          const page = await operations.list.call(input, { signal });
          return {
            ...page,
            items: page.items.map(withUSDAListIdentity),
          };
        },
      };
    },
    [operations.list],
  );
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<USDAListRow>(),
    [],
  );

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<USDAListRow>((add) => {
        add(
          columnHelper.accessor("fdc_id", {
            header: "FDC ID",
            meta: {
              className: "w-32 max-w-32",
              mobile: { slot: "trailing", priority: 20 },
            },
            cell: (info) => (
              <TableLink
                to="/usda/$id"
                params={{ id: String(info.getValue()) }}
              >
                {info.getValue()}
              </TableLink>
            ),
          }),
        );
        add(
          columnHelper.accessor("foodInfo.data_type", {
            meta: {
              className: "w-32 max-w-32",
              mobile: { slot: "subtitle", priority: 10 },
              filterConfig: {
                placeholder: "Filter by type...",
                filterType: "select" as const,
                options: Object.values(dataTypeEnum.enum).map((type) => ({
                  value: type,
                  label: dataTypeLabel(type),
                  color: dataTypeColor(type),
                })),
              },
            },
            id: "foodInfo-data_type",
            enableSorting: true,
            header: "Type",
            cell: (info) => {
              const type = info.getValue();
              return (
                <span className="inline-flex items-center gap-2">
                  <UsdaDataTypeDot dataType={type} />
                  {dataTypeLabel(type)}
                </span>
              );
            },
          }),
        );
        add(
          columnHelper.accessor("brandedFoodInfo", {
            header: "Brand Info",
            meta: {
              className: "w-56",
              mobile: { slot: "meta", priority: 20 },
            },
            cell: (info) => {
              const brandedFood = info.getValue();
              if (!brandedFood) return <NoneValue />;

              return (
                <div className="flex flex-col space-y-1">
                  <div className="text-sm">
                    {brandedFood.brand_owner || <NoneValue />}
                  </div>
                  {brandedFood.branded_food_category && (
                    <Description as="div" size="xs" className="truncate">
                      {brandedFood.branded_food_category}
                    </Description>
                  )}
                  {brandedFood.gtin_upc && (
                    <div className="font-mono text-xs">
                      UPC:{" "}
                      <TableLink
                        to="/usda/upc/$code"
                        params={{ code: brandedFood.gtin_upc }}
                        variant="mono"
                      >
                        {brandedFood.gtin_upc}
                      </TableLink>
                    </div>
                  )}
                </div>
              );
            },
          }),
        );
        add(
          columnHelper.accessor("nutritionInfo", {
            header: "Nutrition",
            meta: {
              className: "w-56",
              mobile: { slot: "meta", priority: 30 },
            },
            cell: (info) => {
              const nutritionInfo = info.getValue();
              const total = nutrientCount(nutritionInfo.nutrientsPer100);
              if (total === 0) return <NoneValue />;
              return (
                <Stack gap="sm" className="w-48">
                  <CoreNutrientCoverage
                    nutrients={nutritionInfo.nutrientsPer100}
                  />
                  <Description as="div" size="2xs">
                    {total} nutrients total
                  </Description>
                </Stack>
              );
            },
          }),
        );
        add(
          columnHelper.accessor("inferredUnitMappings", {
            header: "Unit Mappings",
            meta: { className: "w-48" },
            cell: (info) => {
              const inferredUnitMappings = info.getValue();
              if (inferredUnitMappings.length === 0) return <NoneValue />;

              return (
                <div className="w-full">
                  <UnitMappingDisplay
                    mappings={inferredUnitMappings}
                    title=""
                    kinds={USDA_KINDS}
                  />
                </div>
              );
            },
          }),
        );
        add(
          createEntityInlineLinkColumn(
            columnHelper,
            "linkedProducts",
            "product",
            {
              header: "Linked Products",
              className: "w-48 max-w-48",
              enableSorting: true,
              mobile: { slot: "meta", priority: 40, interactive: true },
              filterConfig: {
                placeholder: "Filter linked...",
                filterType: "select",
                options: [{ value: "linked", label: "Linked products only" }],
              },
            },
          ),
        );
      }),
    [columnHelper],
  );

  const { workbench, inspection } = useEntityList<USDAListRow, USDAListFilters>(
    {
      entity: "usda-food",
      filters: USDA_FILTERS,
      preview: { idField: "fdc_id", responsiveInspector: true },
      queryOptions,
      buildFilters: buildUSDAFilters,
      columns,
      tableStateOptions: USDA_TABLE_STATE,
    },
  );
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    dockedInspector,
    preview,
    inspectorToggle,
  } = inspection;

  return (
    <>
      <ListWorkbench
        model={workbench}
        ariaLabel="USDA Foods Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.rowKey ?? preview?.id}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
      />
      <PreviewSheet />
    </>
  );
}
