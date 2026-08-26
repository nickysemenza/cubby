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
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
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
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
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

const buildUSDAFilters = (tableState: TableStateReturn): USDAListFilters => ({
  nameFilter: tableState.getColumnFilter("foodinfo-description"),
  dataTypeFilter: tableState.getColumnFilter("foodInfo-data_type") as
    | DataType
    | undefined,
  linkedProductsOnly:
    tableState.getColumnFilter("linkedProducts") === "linked" || undefined,
  foodsOnly: true,
});

const USDA_SORT_FIELDS: Record<string, USDAFoodSortField> = {
  fdc_id: "fdc_id",
  "foodinfo-description": "description",
  "foodInfo-data_type": "data_type",
  linkedProducts: "linkedProducts",
};

export const withUSDAListIdentity = <
  TFood extends { fdc_id: number; foodInfo: { description: string } },
>(
  food: TFood,
): TFood & { id: string; name: string } => ({
  ...food,
  id: String(food.fdc_id),
  name: food.foodInfo.description,
});

export function USDAFoodList() {
  const { onRowClick, onRowHover, onRowHoverEnd, PreviewSheet } =
    useEntityPreview("usda-food", {
      idField: "fdc_id",
    });
  const queryOptions = useCallback<ListQueryOptionsFn<USDAListFilters>>(
    (params) => {
      const searching = Boolean(params.filters.nameFilter);
      const listParams = {
        filters: params.filters,
        pagination: params.pagination,
        sort: params.sort,
      };
      const base = usdaFood.list.queryOptions({
        ...listParams,
        sort: searching
          ? [{ orderBy: "relevance", direction: "asc" }]
          : params.sort.map((sort) => ({
              ...sort,
              orderBy: USDA_SORT_FIELDS[sort.orderBy] ?? "fdc_id",
            })),
      });
      const queryFn = base.queryFn;
      if (typeof queryFn !== "function") {
        throw new Error(
          "USDA list query options must include a query function",
        );
      }
      return {
        ...base,
        queryFn: async (context: Parameters<typeof queryFn>[0]) => {
          const page = await queryFn(context);
          return {
            ...page,
            items: page.items.map(withUSDAListIdentity),
          };
        },
      };
    },
    [],
  );
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<USDAListRow>(),
    [],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor("fdc_id", {
        header: "FDC ID",
        meta: { className: "w-32 max-w-32" },
        cell: (info) => (
          <TableLink to="/usda/$id" params={{ id: String(info.getValue()) }}>
            {info.getValue()}
          </TableLink>
        ),
      }),
      columnHelper.accessor("foodInfo.data_type", {
        meta: {
          className: "w-32 max-w-32",
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
      columnHelper.accessor("foodInfo.description", {
        meta: {
          className: "w-72",
          filterConfig: { placeholder: "Filter by description..." },
        },
        id: "foodinfo-description",
        enableSorting: true,
        header: "Description",
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor("brandedFoodInfo", {
        header: "Brand Info",
        meta: { className: "w-56" },
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
      columnHelper.accessor("nutritionInfo", {
        header: "Nutrition",
        meta: { className: "w-56" },
        cell: (info) => {
          const nutritionInfo = info.getValue();
          const total = nutrientCount(nutritionInfo.nutrientsPer100);
          if (total === 0) return <NoneValue />;
          return (
            <Stack gap="sm" className="w-48">
              <CoreNutrientCoverage nutrients={nutritionInfo.nutrientsPer100} />
              <Description as="div" size="2xs">
                {total} nutrients total
              </Description>
            </Stack>
          );
        },
      }),
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
      createEntityInlineLinkColumn(columnHelper, "linkedProducts", "product", {
        header: "Linked Products",
        className: "w-48 max-w-48",
        enableSorting: true,
        filterConfig: {
          placeholder: "Filter linked...",
          filterType: "select",
          options: [{ value: "linked", label: "Linked products only" }],
        },
      }),
    ],
    [columnHelper],
  );

  const { workbench } = useEntityList<USDAListRow, USDAListFilters>({
    entity: "usda-food",
    queryOptions,
    buildFilters: buildUSDAFilters,
    columns,
    tableStateOptions: USDA_TABLE_STATE,
    layoutKey: "usdaFood",
    legacyLayoutSizingKey: "usdaFood",
  });

  return (
    <>
      <ListWorkbench
        model={workbench}
        ariaLabel="USDA Foods Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
      />
      <PreviewSheet />
    </>
  );
}
