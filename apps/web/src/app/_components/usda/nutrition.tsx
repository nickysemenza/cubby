import type { NutrientSummary, NutritionInfo } from "@cubby/usda-schemas";
import { useMemo } from "react";

import { useTableColumnLayout } from "../data-table/column-layout";
import RTable from "../data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "../data-table/table-features";

export const NutritionInfoTable: React.FC<{
  n: NutritionInfo;
}> = ({ n }) => {
  const { nutrientSummary } = n;
  const columnHelper = createCubbyColumnHelper<NutrientSummary>();

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<NutrientSummary>((add) => {
        add(
          columnHelper.accessor("name", {
            header: "Nutrient",
            enableSorting: false,
            size: 200,
            minSize: 100,
            maxSize: 300,
            meta: { className: "min-w-[100px] max-w-[200px] truncate" },
          }),
        );
        add(
          columnHelper.accessor("amount", {
            header: "Amount",
            enableSorting: false,
            size: 96,
            minSize: 60,
            meta: { className: "min-w-[60px] text-right" },
          }),
        );
        add(
          columnHelper.accessor("unit", {
            header: "Unit",
            enableSorting: false,
            size: 64,
            minSize: 40,
            meta: { className: "min-w-[40px]" },
          }),
        );
      }),
    [columnHelper],
  );

  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: nutrientSummary,
    columns: tableColumns,
    meta: { defaultLayout },
    enableSorting: false,
    enableFilters: false,
    getRowId: (row) => `${row.name}-${row.unit}`,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
      pagination: {
        pageSize: 10,
        pageIndex: 0,
      },
    },
  });

  if (nutrientSummary.length === 0) {
    return null;
  }

  return (
    <div className="text-xs">
      <RTable table={table} embedded />
    </div>
  );
};
