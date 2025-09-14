"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import RTable from "../_components/data-table/Table";
import React from "react";
import { NoneState } from "../_components/NoneState";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { TableLink } from "../_components/table";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { unitMappingFromPortionInfo } from "~/schemas/combo";

import { useQuery } from "@tanstack/react-query";

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
        dataTypeFilter: tableState.getColumnFilter("foodInfo-data_type"),
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
              <div className="text-muted-foreground truncate text-xs">
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
    columnHelper.accessor("portionInfoRaw", {
      header: "Portions",
      cell: (info) => {
        const portionInfoRaw = info.getValue();
        const row = info.row.original;
        if (portionInfoRaw.length === 0) return <NoneState />;

        // Parse raw portions to unit mappings on the client side
        const parsedPortions = portionInfoRaw.map((p) =>
          unitMappingFromPortionInfo(p, row.fdc_id),
        );

        return (
          <div className="w-full">
            <UnitMappingDisplay mappings={parsedPortions} title="" />
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
    { id: "foodInfo-data_type", placeholder: "Filter by type..." },
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
