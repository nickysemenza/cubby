"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import RTable from "../_components/data-table/Table";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import {
  FoodPillLink,
  IngredientPillLink,
  LocationPillLink,
} from "../_components/EntityPill";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { NoneState } from "../_components/NoneState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
  createUnitMappingsColumn,
  createInventoryEntriesColumn,
} from "../_components/data-table/columnHelpers";
import { TableLink } from "../_components/table";
import { useTableList } from "../_components/hooks/useTableList";
import { type ProductWithFoodOut } from "~/server/services/product.service";

export function ProductList() {
  const api = useTRPC();

  const { data, totalCount, isLoading, error, tableState } = useTableList<
    {
      nameFilter: string | undefined;
      manufacturerFilter: string | undefined;
      upcFilter: string | undefined;
    },
    ProductWithFoodOut
  >({
    queryOptions: api.product.list.queryOptions,
    buildFilters: (tableState) => ({
      nameFilter: tableState.getColumnFilter("name"),
      manufacturerFilter: tableState.getColumnFilter("manufacturer"),
      upcFilter: tableState.getColumnFilter("upc"),
    }),
    tableStateOptions: { initialSort: "createdAt" },
  });

  // Pre-load unit mappings for all products asynchronously (parallelized)
  const mappingsMap = useAsyncMemo(
    async (signal) => {
      const entries = await Promise.all(
        data.map(async (product) => {
          const mappings = await getAllUnitMappingsFromProduct(product);
          return [product.id, mappings] as const;
        }),
      );
      if (signal.cancelled) return {};
      return Object.fromEntries(entries);
    },
    [data],
    {},
  );

  const columnHelper = createColumnHelper<ProductWithFoodOut>();

  // Set up columns using helpers where possible
  const columns = [
    createImageColumn(columnHelper),
    createNameColumn(columnHelper, "product"),
    columnHelper.accessor("ingredient", {
      cell: (info) => {
        const ingredient = info.getValue();
        return ingredient ? (
          <IngredientPillLink name={ingredient.name} id={ingredient.id} />
        ) : (
          <NoneState />
        );
      },
    }),

    columnHelper.accessor("manufacturer", {
      meta: {
        mobileCategory: "compact", // Override default "medium" categorization
      },
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("upc", {
      cell: (info) => {
        const upc = info.getValue();
        return upc ? (
          <TableLink href={`/usda/upc/${upc}`} variant="mono">
            {upc}
          </TableLink>
        ) : (
          <NoneState />
        );
      },
    }),
    columnHelper.accessor("ndb_number", {
      header: "NDB",
      cell: (info) =>
        info.getValue() ? (
          <TableLink href={`/usda/ndb/${info.getValue()}`} variant="mono">
            {info.getValue()}
          </TableLink>
        ) : (
          <NoneState />
        ),
    }),
    columnHelper.accessor("model", {
      cell: (info) =>
        info.getValue() ? <code>{info.getValue()}</code> : <NoneState />,
    }),
    columnHelper.accessor("food", {
      id: "food info",
      meta: {
        mobileCategory: "compact", // Override default "medium" categorization
        className: "w-96 max-w-96",
      },
      cell: (info) => {
        const food = info.getValue();
        if (!food) return <NoneState />;
        const { nutritionInfo } = food;
        return (
          <div className="w-48">
            <FoodPillLink food={food} />
            <NutritionInfoTable n={nutritionInfo} limit={3} />
          </div>
        );
      },
    }),
    createUnitMappingsColumn(columnHelper, mappingsMap),
    createInventoryEntriesColumn(
      columnHelper,
      "inventoryEntry",
      LocationPillLink,
      "location",
      (e) => e.location,
    ),
    createCreatedAtColumn(columnHelper),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount,
  });

  const filterableColumns = [
    {
      id: "name",
      placeholder: "Filter by name...",
    },
    {
      id: "manufacturer",
      placeholder: "Filter by manufacturer...",
    },
    {
      id: "upc",
      placeholder: "Filter by UPC...",
    },
  ];

  return (
    <div>
      <RTable
        table={table}
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="Products Table"
      />
    </div>
  );
}
