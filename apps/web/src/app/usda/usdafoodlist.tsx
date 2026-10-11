import type { UsdaFoodListRow, USDAFoodSortField } from "@cubby/schemas/usda";
import { usdaListInput } from "@cubby/schemas/usda";
import { type DataType, dataTypeEnum, dataTypeLabel } from "@cubby/usda";
import { useCallback, useEffect, useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { EntityShelf } from "~/entity/entity-list/entity-shelf";
import {
  useEntityListCardDensity,
  useListSearch,
} from "~/entity/entity-list/generic-entity-list";
import { resolveListView } from "~/entity/entity-list/resolve-list-view";
import { getEntityFilters } from "~/entity/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
} from "~/entity/filters";
import { usdaFood } from "~/integrations/tanstack-query/generated/catalog.gen";
import { USDA_KINDS } from "~/lib/conversion-coverage";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { nutrientCount } from "~/lib/usda-food-stats";
import { DataTableToolbar } from "~/ui/data-table/data-table-toolbar";
import { TableEmptyState } from "~/ui/data-table/entity-empty-states";
import { ListWorkbench } from "~/ui/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { useEntityList } from "~/ui/hooks/useEntityList";
import { Row, Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";
import { NoneValue } from "~/ui/primitives/none-value";

import { UnitMappingDisplay } from "../../features/units/UnitMappingDisplay";
import { CoreNutrientCoverage } from "../../features/usda/core-nutrient-coverage";
import { createEntityInlineLinkColumn } from "../../ui/data-table/columnHelpers";
import type { TableStateReturn } from "../../ui/data-table/useTableState";
import type { ListQueryOptionsFn } from "../../ui/hooks/usePaginatedTableCore";

type USDAListRow = UsdaFoodListRow & {
  id: string;
  name: string;
  description: string;
};

type USDAListFilters = {
  nameFilter?: string;
  dataTypeFilter?: DataType;
  linkedProductsOnly?: boolean;
  foodsOnly: boolean;
};

const USDA_TABLE_STATE = { initialSort: "fdc_id" } as const;
const USDA_FILTERS = [
  { id: "description", placeholder: "Filter by description..." },
];

export interface USDAFoodListOperations {
  list: typeof usdaFood.list;
}

const productionOperations: USDAFoodListOperations = { list: usdaFood.list };

const buildUSDAFilters = (tableState: TableStateReturn): USDAListFilters => {
  const declared = usdaListInput.shape.filters.parse(
    buildFiltersFromManifest(
      getEntityFilters("usda-food"),
      filterGetterFromColumnFilters(tableState.allFilters),
    ),
  );
  return {
    ...declared,
    nameFilter:
      declared.nameFilter ?? tableState.getColumnFilter("description"),
    dataTypeFilter:
      declared.dataTypeFilter ??
      dataTypeEnum
        .optional()
        .parse(tableState.getColumnFilter("foodInfo-data_type")),
    linkedProductsOnly:
      declared.linkedProductsOnly ??
      (tableState.getColumnFilter("linkedProducts") === "linked" || undefined),
    foodsOnly: declared.foodsOnly ?? true,
  };
};

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
): TFood & { id: string; name: string; description: string } => ({
  ...food,
  id: String(food.fdc_id),
  name: food.foodInfo.description,
  description: food.foodInfo.description,
});

export function USDAFoodList({
  operations = productionOperations,
}: {
  operations?: USDAFoodListOperations;
}) {
  const { search } = useListSearch();
  const { view } = resolveListView("usda-food", search);
  const { density } = useEntityListCardDensity();
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
              <EntityRefLink
                variant="table"
                to="/usda/$id"
                params={{ id: String(info.getValue()) }}
              >
                {info.getValue()}
              </EntityRefLink>
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
          columnHelper.accessor((row) => row.brandedFoodInfo?.brand_owner, {
            id: "brandOwner",
            header: "Brand",
            meta: {
              className: "w-48 max-w-48",
              mobile: { slot: "meta", priority: 20 },
            },
            cell: (info) => {
              const owner = info.getValue();
              if (!owner) return <NoneValue />;
              return <span className="block truncate">{owner}</span>;
            },
          }),
        );
        add(
          columnHelper.accessor(
            (row) => row.brandedFoodInfo?.branded_food_category,
            {
              id: "brandCategory",
              header: "Category",
              meta: { className: "w-48 max-w-48" },
              cell: (info) => {
                const category = info.getValue();
                if (!category) return <NoneValue />;
                return (
                  <Description as="span" size="xs" className="block truncate">
                    {category}
                  </Description>
                );
              },
            },
          ),
        );
        add(
          columnHelper.accessor((row) => row.brandedFoodInfo?.gtin_upc, {
            id: "gtinUpc",
            header: "UPC",
            meta: {
              className: "w-36 max-w-36",
              mobile: { slot: "meta", priority: 25 },
            },
            cell: (info) => {
              const upc = info.getValue();
              if (!upc) return <NoneValue />;
              return (
                <EntityRefLink
                  variant="table"
                  to="/usda/upc/$code"
                  params={{ code: upc }}
                  tone="mono"
                >
                  {upc}
                </EntityRefLink>
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
                <Row align="center" gap="sm">
                  <CoreNutrientCoverage
                    nutrients={nutritionInfo.nutrientsPer100}
                  />
                  <Description
                    as="span"
                    size="2xs"
                    className="whitespace-nowrap"
                    title={`${total} nutrients total`}
                  >
                    {total} total
                  </Description>
                </Row>
              );
            },
          }),
        );
        add(
          columnHelper.accessor("inferredUnitMappings", {
            header: "Unit Mappings",
            meta: { className: "min-w-0 w-32" },
            cell: (info) => {
              const inferredUnitMappings = info.getValue();
              if (inferredUnitMappings.length === 0) return <NoneValue />;

              return (
                <div className="w-full">
                  <UnitMappingDisplay
                    mappings={inferredUnitMappings}
                    title=""
                    compact
                    showTier
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
    inspectRow,
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    dockedInspector,
    preview,
    inspectorToggle,
  } = inspection;

  useEffect(() => {
    if (
      view !== "table" &&
      Object.keys(workbench.table.atoms.rowSelection?.get() ?? {}).length > 0
    )
      workbench.table.resetRowSelection();
  }, [view, workbench.table]);

  return (
    <>
      {view === "table" ? (
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
      ) : (
        <Stack gap="sm">
          <DataTableToolbar
            table={workbench.table}
            entity="usda-food"
            portalWorkbenchUtilities
          />
          {inspectorToggle}
          <div
            className={
              dockedInspector
                ? "grid min-w-0 grid-cols-[minmax(0,1fr)_25rem]"
                : "min-w-0"
            }
          >
            <div className="min-w-0">
              <EntityShelf
                emptyState={
                  <TableEmptyState entity="usda-food" table={workbench.table} />
                }
                entity="usda-food"
                items={workbench.table
                  .getRowModel()
                  .rows.map((row) => row.original)}
                compact={density === "compact"}
                isLoading={workbench.isLoading}
                error={workbench.error}
                infiniteScroll={workbench.infiniteScroll}
                onRetry={() => void workbench.refreshControls.onRefresh()}
                onInspect={(record) => inspectRow({ original: record })}
                onRowHover={(record) => onRowHover({ original: record })}
                onRowHoverEnd={(record) => onRowHoverEnd({ original: record })}
                currentRowId={preview?.id}
              />
            </div>
            {dockedInspector && (
              <aside className="max-h-[calc(100vh-10rem)] overflow-y-auto border-l border-[var(--border)]">
                {dockedInspector}
              </aside>
            )}
          </div>
        </Stack>
      )}
      <PreviewSheet />
    </>
  );
}
