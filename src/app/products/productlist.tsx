"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import RTable from "../_components/data-table/Table";
import React from "react";
import {
  IngredientPillLink,
  LocationPillLink,
} from "../_components/EntityPill";
import { useWasm } from "~/hooks/useWasm";
import { UnitMapping } from "~/schemas/unitmapping";
import { unitMappingsFromProduct } from "~/schemas/combo";
import { NutritionInfoTable } from "../_components/usda/nutrition";
import { UnitMappingDisplay } from "../_components/units/UnitMappingDisplay";
import { tryFormatMeasure } from "../_components/inventory/format-amount";
import { NoneState } from "../_components/NoneState";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createImageColumn,
} from "../_components/data-table/columnHelpers";
import { EntityPillLinkList } from "../_components/EntityPillLinkList";
import { TableLink } from "../_components/table";

import { useQuery } from "@tanstack/react-query";

export function ProductList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const { data: productsResp, isLoading } = useQuery(
    api.product.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters: {
        nameFilter: tableState.getColumnFilter("name"),
        manufacturerFilter: tableState.getColumnFilter("manufacturer"),
        upcFilter: tableState.getColumnFilter("upc"),
      },
    }),
  );

  const w = useWasm();
  const data = productsResp?.items || [];
  const columnHelper = createColumnHelper<Flatten<typeof data>>();

  // Set up columns using helpers where possible
  const columns = [
    createImageColumn(columnHelper),
    columnHelper.accessor("name", {
      cell: (info) => {
        const ingredient = info.row.original.ingredient;
        return (
          <div className="flex flex-col">
            <TableLink href={`products/${info.row.original.id}`}>
              {info.getValue()}
            </TableLink>
            {ingredient && (
              <IngredientPillLink name={ingredient.name} id={ingredient.id} />
            )}
          </div>
        );
      },
    }),
    columnHelper.accessor("manufacturer", {
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
      cell: (info) => {
        const food = info.getValue();
        if (!food) return <NoneState />;
        const { nutritionInfo } = food;
        return (
          <div className="w-48">
            <NutritionInfoTable n={nutritionInfo} limit={3} />
          </div>
        );
      },
    }),
    columnHelper.accessor("unitMappings", {
      enableSorting: false,
      cell: (info) => {
        const mappings: UnitMapping[] = unitMappingsFromProduct(
          info.row.original,
        );
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
        <div className="space-y-0.5">
          <div className="space-y-0.5 text-xs">
            {info.getValue().map((e) => (
              <div key={e.id}>{tryFormatMeasure(w, e.amount)}</div>
            ))}
          </div>
          <EntityPillLinkList
            items={info.getValue().map((e) => e.location)}
            Pill={LocationPillLink}
            pillPropName="location"
          />
        </div>
      ),
    }),
    createCreatedAtColumn(columnHelper),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: productsResp?.meta?.totalCount || 0,
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
      />
    </div>
  );
}
