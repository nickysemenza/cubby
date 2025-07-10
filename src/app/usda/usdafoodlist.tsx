"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import RTable from "../_components/data-table/Table";
import Link from "next/link";
import React from "react";
import { NoneState } from "../_components/NoneState";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";

import { useQuery } from "@tanstack/react-query";

export function USDAFoodList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "fdc_id" });

  // Query data with params from table state
  const { data: foodsResp, isLoading } = useQuery(
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
      cell: (info) => (
        <Link
          className="font-medium text-blue-600 hover:underline dark:text-blue-500"
          href={`usda/${info.getValue()}`}
        >
          {info.getValue()}
        </Link>
      ),
    }),
    columnHelper.accessor("foodInfo.description", {
      id: "foodinfo-description",
      header: "Description",
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("foodInfo.data_type", {
      id: "foodInfo-data_type",
      header: "Type",
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("brandedFoodInfo", {
      header: "Brand Info",
      cell: (info) => {
        const brandedFood = info.getValue();
        if (!brandedFood) return <NoneState />;

        return (
          <div className="flex flex-col">
            <div>{brandedFood.brand_owner || <NoneState />}</div>
            {brandedFood.branded_food_category && (
              <div className="text-xs text-gray-500">
                {brandedFood.branded_food_category}
              </div>
            )}
            {brandedFood.gtin_upc && (
              <div className="font-mono text-xs">
                UPC:{" "}
                <Link
                  href={`/usda/upc/${brandedFood.gtin_upc}`}
                  className="text-blue-600 hover:underline"
                >
                  {brandedFood.gtin_upc}
                </Link>
              </div>
            )}
          </div>
        );
      },
    }),
    columnHelper.accessor("nutritionInfo", {
      header: "Nutrition",
      cell: (info) => {
        const nutritionInfo = info.getValue();
        return (
          <div className="w-64">
            <NutritionInfoTable n={nutritionInfo} limit={5} />
          </div>
        );
      },
    }),
    columnHelper.accessor("portionInfo", {
      header: "Portions",
      cell: (info) => {
        const portionInfo = info.getValue();
        if (portionInfo.raw.length === 0) return <NoneState />;

        return (
          <div className="w-full">
            <UnitMappingDisplay mappings={portionInfo.parsed} title="" />
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
      />
    </div>
  );
}
