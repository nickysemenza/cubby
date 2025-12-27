"use client";
import { type DataType, dataTypeEnum } from "@recipehub/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import type { Flatten } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";
import RTable from "../_components/data-table/Table";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { useTableState } from "../_components/data-table/useTableState";
import { ProductPillLink } from "../_components/EntityPill";
import { NoneState } from "../_components/NoneState";
import { TableLink } from "../_components/table";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { NutritionInfoTable } from "../_components/usda/nutrition";

export function USDAFoodList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "fdc_id" });

  // Query data with params from table state
  const {
    data: foodsResp,
    isLoading,
    error,
  } = useQuery(
    api.usda.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters: {
        nameFilter: tableState.getColumnFilter("foodinfo-description"),
        dataTypeFilter: tableState.getColumnFilter("foodInfo-data_type") as
          | DataType
          | undefined,
      },
    }),
  );

  const data = foodsResp?.items || [];
  const columnHelper = createColumnHelper<Flatten<typeof data>>();

  // Set up columns
  const columns = [
    columnHelper.accessor("fdc_id", {
      header: "FDC ID",
      meta: { className: "w-32 max-w-32" },
      cell: (info) => (
        <TableLink href={`usda/${info.getValue()}`}>
          {info.getValue()}
        </TableLink>
      ),
    }),
    columnHelper.accessor("foodInfo.data_type", {
      meta: { className: "w-32 max-w-32" },
      id: "foodInfo-data_type",
      header: "Type",
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("foodInfo.description", {
      meta: { className: "w-92 max-w-92" },
      id: "foodinfo-description",
      header: "Description",
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("brandedFoodInfo", {
      header: "Brand Info",
      meta: { className: "w-92 max-w-92" },
      cell: (info) => {
        const brandedFood = info.getValue();
        if (!brandedFood) return <NoneState />;

        return (
          <div className="flex flex-col space-y-0.5">
            <div className="text-sm">
              {brandedFood.brand_owner || <NoneState />}
            </div>
            {brandedFood.branded_food_category && (
              <div className="truncate text-muted-foreground text-xs">
                {brandedFood.branded_food_category}
              </div>
            )}
            {brandedFood.gtin_upc && (
              <div className="font-mono text-xs">
                UPC:{" "}
                <TableLink
                  href={`/usda/upc/${brandedFood.gtin_upc}`}
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
      meta: { className: "w-92 max-w-92" },
      cell: (info) => {
        const nutritionInfo = info.getValue();
        return (
          <div className="w-48">
            <NutritionInfoTable n={nutritionInfo} limit={3} />
          </div>
        );
      },
    }),
    columnHelper.accessor("inferredUnitMappings", {
      header: "Unit Mappings",
      cell: (info) => {
        const inferredUnitMappings = info.getValue();
        if (inferredUnitMappings.length === 0) return <NoneState />;

        return (
          <div className="w-full">
            <UnitMappingDisplay mappings={inferredUnitMappings} title="" />
          </div>
        );
      },
    }),
    columnHelper.accessor("linkedProducts", {
      header: "Linked Products",
      meta: { className: "w-48 max-w-48" },
      cell: (info) => {
        const products = info.getValue();
        if (!products || products.length === 0) return <NoneState />;

        return (
          <div className="flex flex-wrap gap-1">
            {products.map((product) => (
              <ProductPillLink key={product.id} product={product} />
            ))}
          </div>
        );
      },
    }),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: foodsResp?.meta.totalCount || 0,
  });

  const filterableColumns = [
    { id: "foodinfo-description", placeholder: "Filter by description..." },
    {
      id: "foodInfo-data_type",
      placeholder: "Filter by type...",
      filterType: "select" as const,
      options: Object.values(dataTypeEnum.enum).map((type) => ({
        value: type,
        label: type,
      })),
    },
  ];

  return (
    <div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="USDA Foods Table"
      />
    </div>
  );
}
