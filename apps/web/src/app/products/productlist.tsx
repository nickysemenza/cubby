"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import RTable from "../_components/data-table/Table";
import React from "react";
import {
  FoodPillLink,
  IngredientPillLink,
  LocationPillLink,
} from "../_components/EntityPill";
import { useWasm } from "~/hooks/useWasm";
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

export function ProductList() {
  const api = useTRPC();
  const w = useWasm();

  const { data, totalCount, isLoading, error, tableState } = useTableList({
    queryOptions: api.product.list.queryOptions,
    buildFilters: (tableState) => ({
      nameFilter: tableState.getColumnFilter("name"),
      manufacturerFilter: tableState.getColumnFilter("manufacturer"),
      upcFilter: tableState.getColumnFilter("upc"),
    }),
    tableStateOptions: { initialSort: "createdAt" },
  });
  const columnHelper = createColumnHelper<Flatten<typeof data>>();

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
        const mappings = getAllUnitMappingsFromProduct(product, w);
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
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {info.getValue().map((e: any) => (
              <div key={e.id}>{tryFormatMeasure(w, e.amount)}</div>
            ))}
          </div>
          {}
          <EntityPillLinkList
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            items={info.getValue().map((e: any) => e.location)}
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
