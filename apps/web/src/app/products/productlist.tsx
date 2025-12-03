"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import RTable from "../_components/data-table/Table";
import React, { useState, useEffect } from "react";
import {
  FoodPillLink,
  IngredientPillLink,
  LocationPillLink,
} from "../_components/EntityPill";
import { SpacedContainer } from "~/components/ui/spaced-container";
import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { tryFormatMeasure } from "../_components/inventory/format-amount";
import { NoneState } from "../_components/NoneState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import { EntityPillLinkList } from "../_components/EntityPillLinkList";
import { TableLink } from "../_components/table";
import { useTableList } from "../_components/hooks/useTableList";
import { type ProductWithFoodOut } from "~/server/services/product.service";
import { type UnitMapping } from "~/schemas/unitmapping";

// Type for inventory entries with location from product list
type InventoryEntryWithLocation = ProductWithFoodOut["inventoryEntry"][number];

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

  // Pre-load unit mappings for all products asynchronously
  const [mappingsMap, setMappingsMap] = useState<
    Record<string, UnitMapping[]>
  >({});
  useEffect(() => {
    const load = async () => {
      const result: Record<string, UnitMapping[]> = {};
      for (const product of data) {
        result[product.id] = await getAllUnitMappingsFromProduct(product);
      }
      setMappingsMap(result);
    };
    void load();
  }, [data]);

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
    columnHelper.accessor("unitMappings", {
      enableSorting: false,
      meta: { className: "w-96 max-w-96" },
      cell: (info) => {
        const product = info.row.original;
        const mappings = mappingsMap[product.id] ?? [];
        return (
          <div className="w-full">
            <UnitMappingDisplay mappings={mappings} title="" />
          </div>
        );
      },
    }),
    columnHelper.accessor("inventoryEntry", {
      enableSorting: false,
      cell: (info) => (
        <SpacedContainer space={0} className="space-y-0.5">
          <div className="space-y-0.5 text-xs">
            {info.getValue().map((e: InventoryEntryWithLocation) => (
              <div key={e.id}>{tryFormatMeasure(e.amount)}</div>
            ))}
          </div>
          {}
          <EntityPillLinkList
            items={info
              .getValue()
              .map((e: InventoryEntryWithLocation) => e.location)}
            Pill={LocationPillLink}
            pillPropName="location"
          />
        </SpacedContainer>
      ),
    }),
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
