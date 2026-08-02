import type {
  FoodSummaryEnrichment,
  USDAFoodSortField,
} from "@cubby/schemas/usda";
import {
  type DataType,
  dataTypeEnum,
  dataTypeLabel,
} from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { USDA_KINDS } from "~/lib/conversion-coverage";
import type { QueryTiming } from "~/lib/query-timing";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { nutrientCount } from "~/lib/usda-food-stats";
import type { Flatten } from "~/misc/array-helpers";
import { createEntityInlineLinkColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { useTableState } from "../_components/data-table/useTableState";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { TableLink } from "../_components/table/TableLink";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { CoreNutrientCoverage } from "../_components/usda/core-nutrient-coverage";

const EMPTY_ENRICHMENT = {
  inferredUnitMappings: [],
  linkedProducts: [],
} satisfies FoodSummaryEnrichment;

export function USDAFoodList() {
  const api = useTRPC();
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview(
    "usda-food",
    {
      idField: "fdc_id",
    },
  );
  // Set up table state
  const tableState = useTableState({ initialSort: "fdc_id" });

  const nameFilter = tableState.getColumnFilter("foodinfo-description");
  const linkedProductsOnly =
    tableState.getColumnFilter("linkedProducts") === "linked";
  const sortParams = nameFilter
    ? ({ orderBy: "relevance", direction: "asc" } as const)
    : (tableState.getSortParams() as {
        orderBy: USDAFoodSortField;
        direction: "asc" | "desc";
      });

  // Query data with params from table state
  const query = useQuery(
    api.usda.listSummaries.queryOptions({
      // While searching by name, rank by FTS relevance (best match first) like
      // the picker; otherwise honor the column sort.
      sort: sortParams,
      pagination: tableState.pagination,
      filters: {
        nameFilter,
        dataTypeFilter: tableState.getColumnFilter("foodInfo-data_type") as
          | DataType
          | undefined,
        linkedProductsOnly,
        // Default to the user-facing food types; picking a specific type in the
        // column filter overrides this server-side (dataTypeFilter wins).
        foodsOnly: true,
      },
    }),
  );

  const { data: foodsResp, isLoading, error, isFetching } = query;
  const fdcIds = useMemo(
    () => foodsResp?.items?.map((food) => food.fdc_id) ?? [],
    [foodsResp?.items],
  );
  const enrichmentsQuery = useQuery(
    api.usda.enrichmentsByID.queryOptions(
      { fdcIds },
      { enabled: fdcIds.length > 0 },
    ),
  );

  // Inline ref-based timing (replaces useQueryWithTiming hook)
  const startTimeRef = useRef<number | null>(null);
  const [timing, setTiming] = useState<QueryTiming>({
    durationMs: null,
    isFresh: false,
  });

  useEffect(() => {
    if (isFetching && startTimeRef.current === null) {
      startTimeRef.current = performance.now();
    }
  }, [isFetching]);

  useEffect(() => {
    if (!isFetching && startTimeRef.current !== null) {
      const duration = Math.round(performance.now() - startTimeRef.current);
      setTiming({ durationMs: duration, isFresh: true });
      startTimeRef.current = null;
    }
  }, [isFetching]);

  const data = useMemo(
    () =>
      (foodsResp?.items ?? []).map((food) => ({
        ...food,
        ...(enrichmentsQuery.data?.[String(food.fdc_id)] ?? EMPTY_ENRICHMENT),
      })),
    [foodsResp?.items, enrichmentsQuery.data],
  );
  const columnHelper = createColumnHelper<Flatten<typeof data>>();

  // Set up columns
  const columns = [
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
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: foodsResp?.meta.totalCount || 0,
    getRowId: (row) => String(row.fdc_id),
    // While name-searching, results are relevance-ranked server-side, so the
    // column sort UI would be misleading — disable it until the filter clears.
    enableSorting: !nameFilter,
  });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="USDA Foods Table"
        sizingKey="usdaFood"
        timing={timing}
        onRowClick={onRowClick}
        onRowHover={onRowHover}
      />
      <PreviewSheet />
    </div>
  );
}
